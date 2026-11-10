import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getRevenueStats } from "~/services/instructorAnalyticsService";

const NOW = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

let n = 0;
function student() {
  return testDb
    .insert(schema.users)
    .values({ name: "S", email: `r${++n}@x.com`, role: schema.UserRole.Student })
    .returning()
    .get();
}
function course(instructorId: number, title = "C") {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: `rc-${++n}`,
      description: "d",
      salesCopy: "s",
      instructorId,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}
function buy(courseId: number, amountPaid: number, createdAt: string, country: string | null = "US") {
  return testDb
    .insert(schema.purchases)
    .values({ userId: student().id, courseId, amountPaid, createdAt, country })
    .returning()
    .get();
}

describe("getRevenueStats", () => {
  it("returns empty stats when there are no purchases", () => {
    course(base.instructor.id);
    expect(getRevenueStats(base.instructor.id, NOW)).toEqual({
      totalRevenue: 0,
      revenueLast30Days: 0,
      purchaseCount: 0,
      byCourse: [],
      byCountry: [],
      teamSeats: { redeemed: 0, total: 0 },
    });
  });

  it("sums total revenue and revenue per course, scoped to the instructor", () => {
    const a = course(base.instructor.id, "A");
    const b = course(base.instructor.id, "B");
    const other = student();
    const foreign = course(other.id, "Foreign");
    buy(a.id, 1000, "2026-01-01T00:00:00.000Z");
    buy(a.id, 500, "2026-01-02T00:00:00.000Z");
    buy(b.id, 2000, "2026-01-03T00:00:00.000Z");
    buy(foreign.id, 9999, "2026-01-03T00:00:00.000Z");

    const stats = getRevenueStats(base.instructor.id, NOW);
    expect(stats.totalRevenue).toBe(3500);
    expect(stats.purchaseCount).toBe(3);
    expect(stats.byCourse).toEqual([
      { courseId: b.id, title: "B", revenue: 2000, purchases: 1 },
      { courseId: a.id, title: "A", revenue: 1500, purchases: 2 },
    ]);
    expect(getRevenueStats("all", NOW).totalRevenue).toBe(13499);
  });

  it("includes purchases exactly 30 days old in the last-30-days revenue", () => {
    const a = course(base.instructor.id);
    buy(a.id, 100, "2026-05-02T00:00:00.000Z"); // exactly 30 days before NOW
    buy(a.id, 200, "2026-05-01T23:59:59.999Z"); // just outside
    buy(a.id, 400, "2026-05-31T12:00:00.000Z");
    const stats = getRevenueStats(base.instructor.id, NOW);
    expect(stats.revenueLast30Days).toBe(500);
    expect(stats.totalRevenue).toBe(700);
  });

  it("groups revenue by buyer country, keeping unknown countries together", () => {
    const a = course(base.instructor.id);
    buy(a.id, 100, "2026-01-01T00:00:00.000Z", "US");
    buy(a.id, 300, "2026-01-01T00:00:00.000Z", "PL");
    buy(a.id, 150, "2026-01-01T00:00:00.000Z", "US");
    buy(a.id, 50, "2026-01-01T00:00:00.000Z", null);
    expect(getRevenueStats(base.instructor.id, NOW).byCountry).toEqual([
      { country: "PL", revenue: 300, purchases: 1 },
      { country: "US", revenue: 250, purchases: 2 },
      { country: null, revenue: 50, purchases: 1 },
    ]);
  });

  it("counts a team purchase once in full at purchase time and reports seat redemption", () => {
    const a = course(base.instructor.id);
    const team = testDb.insert(schema.teams).values({}).returning().get();
    const purchase = buy(a.id, 5000, "2026-05-20T00:00:00.000Z");
    const redeemer = student();
    for (let i = 0; i < 5; i++) {
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: a.id,
          code: `CODE-${i}`,
          purchaseId: purchase.id,
          redeemedByUserId: i < 2 ? redeemer.id : null,
          redeemedAt: i < 2 ? "2026-05-31T00:00:00.000Z" : null,
        })
        .run();
    }
    const stats = getRevenueStats(base.instructor.id, NOW);
    expect(stats.totalRevenue).toBe(5000);
    expect(stats.revenueLast30Days).toBe(5000);
    expect(stats.purchaseCount).toBe(1);
    expect(stats.teamSeats).toEqual({ redeemed: 2, total: 5 });
  });
});
