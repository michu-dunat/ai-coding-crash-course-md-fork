import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  quizAttempts,
  quizzes,
  users,
  videoWatchEvents,
  DEFAULT_AT_RISK_THRESHOLD_DAYS,
} from "~/db/schema";
import {
  getScopedCourseIds,
  type AnalyticsScope,
} from "~/services/instructorAnalytics/scope";

export type WeeklyEnrollment = {
  /** ISO timestamp of the start of the 7-day bucket */
  weekStart: string;
  count: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TREND_WEEKS = 12;

/**
 * New enrollments per rolling 7-day week over the last 12 weeks, oldest
 * first. The final bucket ends at `now`; empty weeks are zero-filled.
 */
export function getWeeklyEnrollments(
  scope: AnalyticsScope,
  now: Date
): WeeklyEnrollment[] {
  const end = now.getTime();
  const start = end - TREND_WEEKS * WEEK_MS;
  const weeks: WeeklyEnrollment[] = Array.from({ length: TREND_WEEKS }, (_, i) => ({
    weekStart: new Date(start + i * WEEK_MS).toISOString(),
    count: 0,
  }));

  const courseIds = getScopedCourseIds(scope);
  if (courseIds.length === 0) return weeks;

  const rows = db
    .select({ enrolledAt: enrollments.enrolledAt })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .all();
  for (const r of rows) {
    const t = new Date(r.enrolledAt).getTime();
    if (t < start || t > end) continue;
    const i = Math.min(Math.floor((t - start) / WEEK_MS), TREND_WEEKS - 1);
    weeks[i].count++;
  }
  return weeks;
}

export type AtRiskStudent = {
  userId: number;
  name: string;
  courseId: number;
  courseTitle: string;
  /** 0–100 share of the course's lessons completed */
  progress: number;
  /** ISO timestamp of the latest in-course activity; the enrollment date only when there is none */
  lastActiveAt: string;
};

export type AtRiskResult = {
  /** Longest inactivity first, capped at AT_RISK_LIMIT */
  students: AtRiskStudent[];
  /** Every at-risk enrollment before the cap; above students.length means truncated */
  total: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const AT_RISK_LIMIT = 25;

/**
 * Enrolled, uncompleted students whose last in-course activity (video events,
 * quiz attempts, comments, lesson completions; enrollment date as fallback)
 * is more than `thresholdDays` before `now`. Longest inactivity first, max 25,
 * with the uncapped total alongside.
 */
export function getAtRiskStudents(
  scope: AnalyticsScope,
  now: Date,
  thresholdDays: number = DEFAULT_AT_RISK_THRESHOLD_DAYS
): AtRiskResult {
  const none: AtRiskResult = { students: [], total: 0 };
  const courseIds = getScopedCourseIds(scope);
  if (courseIds.length === 0) return none;

  const enrollmentRows = db
    .select({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
      enrolledAt: enrollments.enrolledAt,
      name: users.name,
      courseTitle: courses.title,
    })
    .from(enrollments)
    .innerJoin(users, eq(enrollments.userId, users.id))
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(inArray(enrollments.courseId, courseIds), isNull(enrollments.completedAt))
    )
    .all();
  if (enrollmentRows.length === 0) return none;

  const lessonRows = db
    .select({ lessonId: lessons.id, courseId: modules.courseId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .all();
  const lessonCourse = new Map(lessonRows.map((l) => [l.lessonId, l.courseId]));
  const lessonsPerCourse = new Map<number, number>();
  for (const l of lessonRows) {
    lessonsPerCourse.set(l.courseId, (lessonsPerCourse.get(l.courseId) ?? 0) + 1);
  }

  const lastActive = new Map<string, number>();
  const completedCount = new Map<string, number>();
  function touch(userId: number, lessonId: number, at: string | null) {
    const courseId = lessonCourse.get(lessonId);
    if (courseId === undefined || at === null) return;
    const key = `${userId}:${courseId}`;
    const t = new Date(at).getTime();
    if (t > (lastActive.get(key) ?? -Infinity)) lastActive.set(key, t);
  }

  const lessonIds = [...lessonCourse.keys()];
  if (lessonIds.length > 0) {
    const videoRows = db
      .select({ userId: videoWatchEvents.userId, lessonId: videoWatchEvents.lessonId, at: videoWatchEvents.createdAt })
      .from(videoWatchEvents)
      .where(inArray(videoWatchEvents.lessonId, lessonIds))
      .all();
    for (const v of videoRows) touch(v.userId, v.lessonId, v.at);

    const commentRows = db
      .select({ userId: comments.userId, lessonId: comments.lessonId, at: comments.createdAt })
      .from(comments)
      .where(inArray(comments.lessonId, lessonIds))
      .all();
    for (const c of commentRows) touch(c.userId, c.lessonId, c.at);

    const attemptRows = db
      .select({ userId: quizAttempts.userId, lessonId: quizzes.lessonId, at: quizAttempts.attemptedAt })
      .from(quizAttempts)
      .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
      .where(inArray(quizzes.lessonId, lessonIds))
      .all();
    for (const q of attemptRows) touch(q.userId, q.lessonId, q.at);

    const progressRows = db
      .select({ userId: lessonProgress.userId, lessonId: lessonProgress.lessonId, at: lessonProgress.completedAt })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.status, LessonProgressStatus.Completed),
          inArray(lessonProgress.lessonId, lessonIds)
        )
      )
      .all();
    for (const p of progressRows) {
      touch(p.userId, p.lessonId, p.at);
      const key = `${p.userId}:${lessonCourse.get(p.lessonId)}`;
      completedCount.set(key, (completedCount.get(key) ?? 0) + 1);
    }
  }

  const cutoff = now.getTime() - thresholdDays * DAY_MS;
  const atRisk = enrollmentRows
    .map((e) => {
      const key = `${e.userId}:${e.courseId}`;
      const t = lastActive.get(key) ?? new Date(e.enrolledAt).getTime();
      const total = lessonsPerCourse.get(e.courseId) ?? 0;
      const done = completedCount.get(key) ?? 0;
      return {
        row: {
          userId: e.userId,
          name: e.name,
          courseId: e.courseId,
          courseTitle: e.courseTitle,
          progress: total === 0 ? 0 : Math.min(done / total, 1) * 100,
          lastActiveAt: new Date(t).toISOString(),
        },
        t,
      };
    })
    .filter((r) => r.t < cutoff)
    .sort((a, b) => a.t - b.t);
  return {
    students: atRisk.slice(0, AT_RISK_LIMIT).map((r) => r.row),
    total: atRisk.length,
  };
}
