import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  quizAttempts,
  quizzes,
  users,
  videoWatchEvents,
} from "~/db/schema";

/** A single instructor id, or "all" for platform-wide data. */
export type AnalyticsScope = number | "all";

export type OverviewStats = {
  courseCount: number;
  uniqueStudents: number;
  newStudentsLast30Days: number;
  /** 0–100, mean of per-enrollment progress */
  averageProgress: number;
  /** 0–100, share of enrollments completed */
  completionRate: number;
  /** 0–100, share of (student, quiz) best attempts that passed */
  quizPassRate: number;
  /** 0–100, mean of best attempt scores (stored as 0–1 fractions) */
  averageQuizScore: number;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

export function getScopedCourseIds(scope: AnalyticsScope): number[] {
  const statusFilter = inArray(courses.status, INCLUDED_STATUSES);
  return db
    .select({ id: courses.id })
    .from(courses)
    .where(
      scope === "all"
        ? statusFilter
        : and(statusFilter, eq(courses.instructorId, scope))
    )
    .all()
    .map((c) => c.id);
}

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

export function getOverviewStats(
  scope: AnalyticsScope,
  now: Date
): OverviewStats {
  const courseIds = getScopedCourseIds(scope);
  const empty: OverviewStats = {
    courseCount: courseIds.length,
    uniqueStudents: 0,
    newStudentsLast30Days: 0,
    averageProgress: 0,
    completionRate: 0,
    quizPassRate: 0,
    averageQuizScore: 0,
  };
  if (courseIds.length === 0) return empty;

  const enrollmentRows = db
    .select()
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .all();
  if (enrollmentRows.length === 0) return empty;

  // Unique students, keyed by their earliest in-scope enrollment
  const firstEnrolled = new Map<number, number>();
  for (const e of enrollmentRows) {
    const t = new Date(e.enrolledAt).getTime();
    const prev = firstEnrolled.get(e.userId);
    if (prev === undefined || t < prev) firstEnrolled.set(e.userId, t);
  }
  const cutoff = now.getTime() - THIRTY_DAYS_MS;
  const newStudentsLast30Days = [...firstEnrolled.values()].filter(
    (t) => t >= cutoff && t <= now.getTime()
  ).length;

  // Lessons per course
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

  // Completed lessons per (user, course)
  const completedCount = new Map<string, number>();
  if (lessonRows.length > 0) {
    const progressRows = db
      .select({ userId: lessonProgress.userId, lessonId: lessonProgress.lessonId })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.status, LessonProgressStatus.Completed),
          inArray(lessonProgress.lessonId, [...lessonCourse.keys()])
        )
      )
      .all();
    for (const p of progressRows) {
      const key = `${p.userId}:${lessonCourse.get(p.lessonId)}`;
      completedCount.set(key, (completedCount.get(key) ?? 0) + 1);
    }
  }

  let progressSum = 0;
  let completed = 0;
  for (const e of enrollmentRows) {
    const total = lessonsPerCourse.get(e.courseId) ?? 0;
    const done = completedCount.get(`${e.userId}:${e.courseId}`) ?? 0;
    progressSum += total === 0 ? 0 : Math.min(done / total, 1) * 100;
    if (e.completedAt !== null) completed++;
  }

  // Best attempt per (student, quiz)
  const attemptRows = db
    .select({
      userId: quizAttempts.userId,
      quizId: quizAttempts.quizId,
      score: quizAttempts.score,
      passed: quizAttempts.passed,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .all();
  const best = new Map<string, { score: number; passed: boolean }>();
  for (const a of attemptRows) {
    const key = `${a.userId}:${a.quizId}`;
    const prev = best.get(key);
    if (!prev || a.score > prev.score || (a.score === prev.score && a.passed)) {
      best.set(key, { score: a.score, passed: a.passed });
    }
  }
  const bests = [...best.values()];

  return {
    courseCount: courseIds.length,
    uniqueStudents: firstEnrolled.size,
    newStudentsLast30Days,
    averageProgress: progressSum / enrollmentRows.length,
    completionRate: pct(completed, enrollmentRows.length),
    quizPassRate: pct(bests.filter((b) => b.passed).length, bests.length),
    averageQuizScore:
      bests.length === 0
        ? 0
        : (bests.reduce((s, b) => s + b.score, 0) / bests.length) * 100,
  };
}

export type AtRiskStudent = {
  userId: number;
  name: string;
  courseId: number;
  courseTitle: string;
  /** 0–100 share of the course's lessons completed */
  progress: number;
  /** ISO timestamp of the latest in-course activity, or the enrollment date */
  lastActiveAt: string;
};

const AT_RISK_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
const AT_RISK_LIMIT = 25;

/**
 * Enrolled, uncompleted students whose last in-course activity (video events,
 * quiz attempts, comments, lesson completions; enrollment date as fallback)
 * is more than 14 days before `now`. Longest inactivity first, max 25.
 */
export function getAtRiskStudents(
  scope: AnalyticsScope,
  now: Date
): AtRiskStudent[] {
  const courseIds = getScopedCourseIds(scope);
  if (courseIds.length === 0) return [];

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
  if (enrollmentRows.length === 0) return [];

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

  const cutoff = now.getTime() - AT_RISK_THRESHOLD_MS;
  return enrollmentRows
    .map((e) => {
      const key = `${e.userId}:${e.courseId}`;
      const t = Math.max(new Date(e.enrolledAt).getTime(), lastActive.get(key) ?? -Infinity);
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
    .sort((a, b) => a.t - b.t)
    .slice(0, AT_RISK_LIMIT)
    .map((r) => r.row);
}

