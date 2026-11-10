import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  quizAttempts,
  quizzes,
} from "~/db/schema";
import {
  getCourseRatingSummaries,
  type CourseRatingSummary,
} from "~/services/courseRatingService";
import { getUnansweredQuestions } from "~/services/commentService";
import {
  getScopedCourseIds,
  pct,
  THIRTY_DAYS_MS,
  type AnalyticsScope,
} from "~/services/instructorAnalytics/scope";

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

export type CourseBreakdownRow = {
  courseId: number;
  title: string;
  enrollments: number;
  /** 0–100, mean of per-enrollment progress */
  averageProgress: number;
  /** 0–100, share of enrollments completed */
  completionRate: number;
  /** 1dp, null when the course has no ratings */
  averageRating: number | null;
  ratingCount: number;
};

export function getCourseBreakdown(scope: AnalyticsScope): CourseBreakdownRow[] {
  const courseIds = getScopedCourseIds(scope);
  if (courseIds.length === 0) return [];

  const courseRows = db
    .select({ id: courses.id, title: courses.title })
    .from(courses)
    .where(inArray(courses.id, courseIds))
    .orderBy(courses.id)
    .all();

  const enrollmentRows = db
    .select({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .all();

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

  const completedCount = new Map<string, number>();
  if (lessonRows.length > 0 && enrollmentRows.length > 0) {
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

  const perCourse = new Map<number, { count: number; progress: number; completed: number }>();
  for (const e of enrollmentRows) {
    const acc = perCourse.get(e.courseId) ?? { count: 0, progress: 0, completed: 0 };
    const total = lessonsPerCourse.get(e.courseId) ?? 0;
    const done = completedCount.get(`${e.userId}:${e.courseId}`) ?? 0;
    acc.count++;
    acc.progress += total === 0 ? 0 : Math.min(done / total, 1) * 100;
    if (e.completedAt !== null) acc.completed++;
    perCourse.set(e.courseId, acc);
  }

  const ratings = getCourseRatingSummaries(courseIds);

  return courseRows.map((c) => {
    const acc = perCourse.get(c.id) ?? { count: 0, progress: 0, completed: 0 };
    const rating = ratings.get(c.id) ?? { average: null, count: 0 };
    return {
      courseId: c.id,
      title: c.title,
      enrollments: acc.count,
      averageProgress: acc.count === 0 ? 0 : acc.progress / acc.count,
      completionRate: pct(acc.completed, acc.count),
      averageRating: rating.average,
      ratingCount: rating.count,
    };
  });
}

/** Mean of every individual rating across in-scope courses (1dp). */
export function getOverviewRating(scope: AnalyticsScope): CourseRatingSummary {
  let sum = 0;
  let count = 0;
  for (const r of getCourseRatingSummaries(getScopedCourseIds(scope)).values()) {
    if (r.average === null) continue;
    sum += r.average * r.count;
    count += r.count;
  }
  return {
    average: count === 0 ? null : Math.round((sum / count) * 10) / 10,
    count,
  };
}

/** Unanswered questions (see commentService) on in-scope courses. */
export function getUnansweredQuestionCount(scope: AnalyticsScope): number {
  const courseIds = new Set(getScopedCourseIds(scope));
  return getUnansweredQuestions(scope === "all" ? null : scope).filter((q) =>
    courseIds.has(q.courseId)
  ).length;
}
