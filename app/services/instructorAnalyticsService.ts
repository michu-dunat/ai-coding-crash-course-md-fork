import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
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
