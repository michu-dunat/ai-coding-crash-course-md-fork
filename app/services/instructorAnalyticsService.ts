import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  coupons,
  courses,
  CourseStatus,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  users,
  videoWatchEvents,
} from "~/db/schema";
import {
  getCourseRatingSummaries,
  type CourseRatingSummary,
} from "~/services/courseRatingService";
import { getUnansweredQuestions } from "~/services/commentService";

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

export type RevenueStats = {
  /** cents */
  totalRevenue: number;
  /** cents */
  revenueLast30Days: number;
  purchaseCount: number;
  byCourse: { courseId: number; title: string; revenue: number; purchases: number }[];
  byCountry: { country: string | null; revenue: number; purchases: number }[];
  teamSeats: { redeemed: number; total: number };
};

export function getRevenueStats(scope: AnalyticsScope, now: Date): RevenueStats {
  const courseIds = getScopedCourseIds(scope);
  const empty: RevenueStats = {
    totalRevenue: 0,
    revenueLast30Days: 0,
    purchaseCount: 0,
    byCourse: [],
    byCountry: [],
    teamSeats: { redeemed: 0, total: 0 },
  };
  if (courseIds.length === 0) return empty;

  // A team purchase is one purchase row (full amount at purchase time);
  // its seats are the coupons attached to it.
  const rows = db
    .select({
      courseId: purchases.courseId,
      title: courses.title,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(inArray(purchases.courseId, courseIds))
    .all();
  if (rows.length === 0) return empty;

  const cutoff = now.getTime() - THIRTY_DAYS_MS;
  let totalRevenue = 0;
  let revenueLast30Days = 0;
  const byCourse = new Map<number, RevenueStats["byCourse"][number]>();
  const byCountry = new Map<string | null, RevenueStats["byCountry"][number]>();
  for (const r of rows) {
    totalRevenue += r.amountPaid;
    const t = new Date(r.createdAt).getTime();
    if (t >= cutoff && t <= now.getTime()) revenueLast30Days += r.amountPaid;

    const c = byCourse.get(r.courseId) ?? {
      courseId: r.courseId,
      title: r.title,
      revenue: 0,
      purchases: 0,
    };
    c.revenue += r.amountPaid;
    c.purchases++;
    byCourse.set(r.courseId, c);

    const k = byCountry.get(r.country) ?? { country: r.country, revenue: 0, purchases: 0 };
    k.revenue += r.amountPaid;
    k.purchases++;
    byCountry.set(r.country, k);
  }

  const seatRows = db
    .select({ redeemedBy: coupons.redeemedByUserId })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .where(inArray(purchases.courseId, courseIds))
    .all();

  const byRevenueDesc = (a: { revenue: number }, b: { revenue: number }) =>
    b.revenue - a.revenue;
  return {
    totalRevenue,
    revenueLast30Days,
    purchaseCount: rows.length,
    byCourse: [...byCourse.values()].sort(byRevenueDesc),
    byCountry: [...byCountry.values()].sort(byRevenueDesc),
    teamSeats: {
      redeemed: seatRows.filter((s) => s.redeemedBy !== null).length,
      total: seatRows.length,
    },
  };
}

export type ContentCourse = { id: number; title: string; enrollmentCount: number };
export type FunnelStep = { lessonId: number; title: string; completions: number };
export type ContentAnalytics = {
  /** In-scope courses, most-enrolled first */
  courses: ContentCourse[];
  selectedCourseId: number | null;
  enrolledStudents: number;
  /** Lessons in module-then-lesson order with enrolled-student completions */
  funnel: FunnelStep[];
};

/**
 * Content tab data. `requestedCourseId` is honoured only when it is in
 * scope; otherwise the most-enrolled in-scope course is selected.
 */
export function getContentAnalytics(
  scope: AnalyticsScope,
  requestedCourseId: number | null
): ContentAnalytics {
  const courseIds = getScopedCourseIds(scope);
  if (courseIds.length === 0) {
    return { courses: [], selectedCourseId: null, enrolledStudents: 0, funnel: [] };
  }

  const courseRows = db
    .select({ id: courses.id, title: courses.title })
    .from(courses)
    .where(inArray(courses.id, courseIds))
    .all();
  const enrollmentRows = db
    .select({ userId: enrollments.userId, courseId: enrollments.courseId })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .all();
  const counts = new Map<number, number>();
  for (const e of enrollmentRows) counts.set(e.courseId, (counts.get(e.courseId) ?? 0) + 1);

  const courseList = courseRows
    .map((c) => ({ id: c.id, title: c.title, enrollmentCount: counts.get(c.id) ?? 0 }))
    .sort((a, b) => b.enrollmentCount - a.enrollmentCount || a.title.localeCompare(b.title));

  const selectedCourseId =
    requestedCourseId !== null && courseIds.includes(requestedCourseId)
      ? requestedCourseId
      : courseList[0].id;

  const enrolled = new Set(
    enrollmentRows.filter((e) => e.courseId === selectedCourseId).map((e) => e.userId)
  );

  const lessonRows = db
    .select({ lessonId: lessons.id, title: lessons.title })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, selectedCourseId))
    .orderBy(modules.position, lessons.position)
    .all();

  const completions = new Map<number, number>();
  if (lessonRows.length > 0 && enrolled.size > 0) {
    const progressRows = db
      .select({ userId: lessonProgress.userId, lessonId: lessonProgress.lessonId })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.status, LessonProgressStatus.Completed),
          inArray(lessonProgress.lessonId, lessonRows.map((l) => l.lessonId))
        )
      )
      .all();
    for (const p of progressRows) {
      if (!enrolled.has(p.userId)) continue;
      completions.set(p.lessonId, (completions.get(p.lessonId) ?? 0) + 1);
    }
  }

  return {
    courses: courseList,
    selectedCourseId,
    enrolledStudents: enrolled.size,
    funnel: lessonRows.map((l) => ({
      lessonId: l.lessonId,
      title: l.title,
      completions: completions.get(l.lessonId) ?? 0,
    })),
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
