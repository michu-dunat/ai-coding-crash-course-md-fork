import { eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  purchases,
} from "~/db/schema";
import {
  getScopedCourseIds,
  THIRTY_DAYS_MS,
  type AnalyticsScope,
} from "~/services/instructorAnalytics/scope";

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
