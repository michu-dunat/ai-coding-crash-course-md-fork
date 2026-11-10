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

import { getAtRiskStudents, getOverviewStats } from "~/services/instructorAnalyticsService";

const NOW = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getOverviewStats", () => {
  it("returns zeros when the scope has no courses", () => {
    const other = testDb
      .insert(schema.users)
      .values({ name: "Empty", email: "e@x.com", role: schema.UserRole.Instructor })
      .returning()
      .get();
    expect(getOverviewStats(other.id, NOW)).toEqual({
      courseCount: 0,
      uniqueStudents: 0,
      newStudentsLast30Days: 0,
      averageProgress: 0,
      completionRate: 0,
      quizPassRate: 0,
      averageQuizScore: 0,
    });
  });

  let emailN = 0;
  function student() {
    return testDb
      .insert(schema.users)
      .values({ name: "S", email: `s${++emailN}@x.com`, role: schema.UserRole.Student })
      .returning()
      .get();
  }
  function course(instructorId: number, status = schema.CourseStatus.Published) {
    return testDb
      .insert(schema.courses)
      .values({
        title: "C",
        slug: `c-${++emailN}`,
        description: "d",
        salesCopy: "s",
        instructorId,
        categoryId: base.category.id,
        status,
      })
      .returning()
      .get();
  }
  function enroll(userId: number, courseId: number, enrolledAt: string, completedAt: string | null = null) {
    testDb.insert(schema.enrollments).values({ userId, courseId, enrolledAt, completedAt }).run();
  }
  function lessonIn(courseId: number) {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId, title: "M", position: 1 })
      .returning()
      .get();
    return testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "L", position: 1 })
      .returning()
      .get();
  }

  it("counts a student enrolled in several in-scope courses once", () => {
    const s = student();
    const c2 = course(base.instructor.id);
    enroll(s.id, base.course.id, "2026-01-01T00:00:00.000Z");
    enroll(s.id, c2.id, "2026-02-01T00:00:00.000Z");
    enroll(base.user.id, c2.id, "2026-02-01T00:00:00.000Z");
    expect(getOverviewStats(base.instructor.id, NOW).uniqueStudents).toBe(2);
  });

  it("excludes drafts and includes archived courses", () => {
    const draft = course(base.instructor.id, schema.CourseStatus.Draft);
    const archived = course(base.instructor.id, schema.CourseStatus.Archived);
    const a = student();
    const b = student();
    enroll(a.id, draft.id, "2026-01-01T00:00:00.000Z");
    enroll(b.id, archived.id, "2026-01-01T00:00:00.000Z");
    const stats = getOverviewStats(base.instructor.id, NOW);
    expect(stats.courseCount).toBe(2);
    expect(stats.uniqueStudents).toBe(1);
  });

  it("isolates one instructor's data from another's, and 'all' combines them", () => {
    const other = testDb
      .insert(schema.users)
      .values({ name: "O", email: "o@x.com", role: schema.UserRole.Instructor })
      .returning()
      .get();
    const otherCourse = course(other.id);
    enroll(base.user.id, base.course.id, "2026-01-01T00:00:00.000Z");
    enroll(student().id, otherCourse.id, "2026-01-01T00:00:00.000Z");
    enroll(student().id, otherCourse.id, "2026-01-01T00:00:00.000Z");
    expect(getOverviewStats(base.instructor.id, NOW).uniqueStudents).toBe(1);
    expect(getOverviewStats(other.id, NOW).uniqueStudents).toBe(2);
    expect(getOverviewStats("all", NOW).uniqueStudents).toBe(3);
  });

  it("counts new students by first enrollment within the last 30 days, inclusive", () => {
    enroll(student().id, base.course.id, "2026-05-02T00:00:00.000Z"); // exactly 30 days
    enroll(student().id, base.course.id, "2026-05-01T23:59:59.999Z"); // just outside
    const returning = student();
    enroll(returning.id, base.course.id, "2026-01-01T00:00:00.000Z");
    enroll(returning.id, course(base.instructor.id).id, "2026-05-20T00:00:00.000Z");
    expect(getOverviewStats(base.instructor.id, NOW).newStudentsLast30Days).toBe(1);
  });

  it("computes average progress and completion rate across enrollments", () => {
    const l1 = lessonIn(base.course.id);
    lessonIn(base.course.id);
    const a = student();
    const b = student();
    enroll(a.id, base.course.id, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    enroll(b.id, base.course.id, "2026-01-01T00:00:00.000Z");
    const l2 = testDb.select().from(schema.lessons).all().find((l) => l.id !== l1.id)!;
    for (const lessonId of [l1.id, l2.id]) {
      testDb.insert(schema.lessonProgress).values({ userId: a.id, lessonId, status: schema.LessonProgressStatus.Completed }).run();
    }
    testDb.insert(schema.lessonProgress).values({ userId: b.id, lessonId: l1.id, status: schema.LessonProgressStatus.Completed }).run();
    const stats = getOverviewStats(base.instructor.id, NOW);
    expect(stats.averageProgress).toBe(75);
    expect(stats.completionRate).toBe(50);
  });

  it("uses each student's best attempt per quiz for pass rate and average score", () => {
    const lesson = lessonIn(base.course.id);
    const quiz = testDb
      .insert(schema.quizzes)
      .values({ lessonId: lesson.id, title: "Q", passingScore: 0.7 })
      .returning()
      .get();
    const a = student();
    const b = student();
    enroll(a.id, base.course.id, "2026-01-01T00:00:00.000Z");
    enroll(b.id, base.course.id, "2026-01-01T00:00:00.000Z");
    testDb.insert(schema.quizAttempts).values([
      { userId: a.id, quizId: quiz.id, score: 0.4, passed: false },
      { userId: a.id, quizId: quiz.id, score: 0.9, passed: true },
      { userId: b.id, quizId: quiz.id, score: 0.5, passed: false },
    ]).run();
    const stats = getOverviewStats(base.instructor.id, NOW);
    expect(stats.quizPassRate).toBe(50);
    expect(stats.averageQuizScore).toBeCloseTo(70);
  });
});

describe("getAtRiskStudents", () => {
  let n = 0;
  function student(name = "S") {
    return testDb
      .insert(schema.users)
      .values({ name, email: `r${++n}@x.com`, role: schema.UserRole.Student })
      .returning()
      .get();
  }
  function enroll(userId: number, courseId: number, enrolledAt: string, completedAt: string | null = null) {
    testDb.insert(schema.enrollments).values({ userId, courseId, enrolledAt, completedAt }).run();
  }

  it("falls back to the enrollment date and flags only strictly more than 14 days", () => {
    const old = student("Old");
    const edge = student("Edge");
    enroll(old.id, base.course.id, "2026-05-17T23:59:59.999Z");
    enroll(edge.id, base.course.id, "2026-05-18T00:00:00.000Z"); // exactly 14 days
    expect(getAtRiskStudents(base.instructor.id, NOW)).toEqual([
      {
        userId: old.id,
        name: "Old",
        courseId: base.course.id,
        courseTitle: base.course.title,
        progress: 0,
        lastActiveAt: "2026-05-17T23:59:59.999Z",
      },
    ]);
  });

  function lesson() {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "M", position: 1 })
      .returning()
      .get();
    return testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "L", position: 1 })
      .returning()
      .get();
  }
  const OLD = "2026-01-01T00:00:00.000Z";
  const RECENT = "2026-05-25T00:00:00.000Z"; // 7 days ago
  const STALE = "2026-05-01T00:00:00.000Z"; // 31 days ago

  const sources: Record<string, (userId: number, lessonId: number, at: string) => void> = {
    "video watch events": (userId, lessonId, at) =>
      testDb.insert(schema.videoWatchEvents).values({ userId, lessonId, eventType: "play", positionSeconds: 0, createdAt: at }).run(),
    comments: (userId, lessonId, at) =>
      testDb.insert(schema.comments).values({ userId, lessonId, body: "hi", createdAt: at }).run(),
    "quiz attempts": (userId, lessonId, at) => {
      const quiz = testDb.insert(schema.quizzes).values({ lessonId, title: "Q", passingScore: 0.7 }).returning().get();
      testDb.insert(schema.quizAttempts).values({ userId, quizId: quiz.id, score: 0.5, passed: false, attemptedAt: at }).run();
    },
    "lesson completions": (userId, lessonId, at) =>
      testDb.insert(schema.lessonProgress).values({ userId, lessonId, status: schema.LessonProgressStatus.Completed, completedAt: at }).run(),
  };

  for (const [label, record] of Object.entries(sources)) {
    it(`counts ${label} as activity`, () => {
      const l = lesson();
      const active = student();
      const stale = student();
      enroll(active.id, base.course.id, OLD);
      enroll(stale.id, base.course.id, OLD);
      record(active.id, l.id, RECENT);
      record(stale.id, l.id, STALE);
      const rows = getAtRiskStudents(base.instructor.id, NOW);
      expect(rows.map((r) => r.userId)).toEqual([stale.id]);
      expect(rows[0].lastActiveAt).toBe(STALE);
    });
  }

  it("ignores activity in other courses", () => {
    const other = testDb
      .insert(schema.courses)
      .values({ title: "Other", slug: "other-c", description: "d", salesCopy: "s", instructorId: base.instructor.id, categoryId: base.category.id, status: schema.CourseStatus.Published })
      .returning()
      .get();
    const mod = testDb.insert(schema.modules).values({ courseId: other.id, title: "M", position: 1 }).returning().get();
    const l = testDb.insert(schema.lessons).values({ moduleId: mod.id, title: "L", position: 1 }).returning().get();
    const s = student();
    enroll(s.id, base.course.id, OLD);
    sources.comments(s.id, l.id, RECENT);
    expect(getAtRiskStudents(base.instructor.id, NOW).map((r) => [r.userId, r.courseId])).toEqual([
      [s.id, base.course.id],
    ]);
  });

  it("reports progress as the share of lessons completed", () => {
    const a = lesson();
    lesson();
    const s = student();
    enroll(s.id, base.course.id, OLD);
    sources["lesson completions"](s.id, a.id, STALE);
    expect(getAtRiskStudents(base.instructor.id, NOW)[0].progress).toBe(50);
  });

  it("never lists students who completed the course", () => {
    enroll(student().id, base.course.id, OLD, "2026-02-01T00:00:00.000Z");
    expect(getAtRiskStudents(base.instructor.id, NOW)).toEqual([]);
  });

  it("sorts by longest inactivity first and caps at 25", () => {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const s = student();
      ids.push(s.id);
      // i = 0 is the most recently enrolled, i = 29 the oldest
      enroll(s.id, base.course.id, new Date(Date.UTC(2026, 3, 30 - i)).toISOString());
    }
    const rows = getAtRiskStudents(base.instructor.id, NOW);
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.userId)).toEqual(ids.slice(5).reverse());
  });

  it("respects instructor scope and 'all'", () => {
    const other = testDb
      .insert(schema.users)
      .values({ name: "O", email: "o-risk@x.com", role: schema.UserRole.Instructor })
      .returning()
      .get();
    const otherCourse = testDb
      .insert(schema.courses)
      .values({ title: "Other", slug: "other-risk", description: "d", salesCopy: "s", instructorId: other.id, categoryId: base.category.id, status: schema.CourseStatus.Published })
      .returning()
      .get();
    const mine = student();
    const theirs = student();
    enroll(mine.id, base.course.id, OLD);
    enroll(theirs.id, otherCourse.id, OLD);
    expect(getAtRiskStudents(base.instructor.id, NOW).map((r) => r.userId)).toEqual([mine.id]);
    expect(getAtRiskStudents(other.id, NOW).map((r) => r.userId)).toEqual([theirs.id]);
    expect(getAtRiskStudents("all", NOW)).toHaveLength(2);
  });
});
