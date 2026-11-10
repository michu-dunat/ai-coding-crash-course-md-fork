import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  quizAttempts,
  quizzes,
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
