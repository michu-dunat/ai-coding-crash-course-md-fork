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

import { getOverviewStats } from "~/services/instructorAnalyticsService";
import { getWeeklyEnrollments } from "~/services/instructorAnalyticsService";
import { getContentAnalytics } from "~/services/instructorAnalyticsService";

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

describe("getWeeklyEnrollments", () => {
  const DAY = 24 * 60 * 60 * 1000;
  let n = 0;
  function makeCourse(instructorId: number) {
    return testDb
      .insert(schema.courses)
      .values({
        title: "C",
        slug: `wk-${++n}`,
        description: "d",
        salesCopy: "s",
        instructorId,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
  }
  function enrollAt(courseId: number, daysAgo: number) {
    const user = testDb
      .insert(schema.users)
      .values({ name: "S", email: `wk${++n}@x.com`, role: schema.UserRole.Student })
      .returning()
      .get();
    const enrolledAt = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
    testDb.insert(schema.enrollments).values({ userId: user.id, courseId, enrolledAt }).run();
  }

  it("returns 12 zero-filled weeks, oldest first, ending at now", () => {
    const weeks = getWeeklyEnrollments(base.instructor.id, NOW);
    expect(weeks).toHaveLength(12);
    expect(weeks.every((w) => w.count === 0)).toBe(true);
    expect(weeks[11].weekStart).toBe("2026-05-25T00:00:00.000Z");
    expect(weeks[0].weekStart).toBe("2026-03-09T00:00:00.000Z");
  });

  it("buckets enrollments into weeks relative to now", () => {
    const c = makeCourse(base.instructor.id);
    enrollAt(c.id, 0);
    enrollAt(c.id, 6.9);
    enrollAt(c.id, 7.5);
    enrollAt(c.id, 20);
    const counts = getWeeklyEnrollments(base.instructor.id, NOW).map((w) => w.count);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2]);
  });

  it("excludes enrollments outside the 12-week window", () => {
    const c = makeCourse(base.instructor.id);
    enrollAt(c.id, 84); // exactly at window start: included
    enrollAt(c.id, 84.1); // just before: excluded
    enrollAt(c.id, -1); // in the future: excluded
    const counts = getWeeklyEnrollments(base.instructor.id, NOW).map((w) => w.count);
    expect(counts).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("respects scope", () => {
    const other = testDb
      .insert(schema.users)
      .values({ name: "O", email: "o-wk@x.com", role: schema.UserRole.Instructor })
      .returning()
      .get();
    enrollAt(makeCourse(base.instructor.id).id, 1);
    enrollAt(makeCourse(other.id).id, 1);
    const sum = (s: number | "all") =>
      getWeeklyEnrollments(s, NOW).reduce((a, w) => a + w.count, 0);
    expect(sum(base.instructor.id)).toBe(1);
    expect(sum(other.id)).toBe(1);
    expect(sum("all")).toBe(2);
  });
});

describe("getContentAnalytics", () => {
  let n = 0;
  function makeCourse(instructorId: number, title: string) {
    return testDb
      .insert(schema.courses)
      .values({
        title,
        slug: `ct-${++n}`,
        description: "d",
        salesCopy: "s",
        instructorId,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
  }
  function makeInstructor() {
    return testDb
      .insert(schema.users)
      .values({ name: "I", email: `ci${++n}@x.com`, role: schema.UserRole.Instructor })
      .returning()
      .get();
  }
  function makeStudent() {
    return testDb
      .insert(schema.users)
      .values({ name: "S", email: `cs${++n}@x.com`, role: schema.UserRole.Student })
      .returning()
      .get();
  }
  function enroll(userId: number, courseId: number) {
    testDb
      .insert(schema.enrollments)
      .values({ userId, courseId, enrolledAt: "2026-05-01T00:00:00.000Z" })
      .run();
  }
  function makeModule(courseId: number, position: number) {
    return testDb
      .insert(schema.modules)
      .values({ courseId, title: `M${position}`, position })
      .returning()
      .get();
  }
  function makeLesson(moduleId: number, title: string, position: number) {
    return testDb
      .insert(schema.lessons)
      .values({ moduleId, title, position })
      .returning()
      .get();
  }
  function progress(userId: number, lessonId: number, status = schema.LessonProgressStatus.Completed) {
    testDb.insert(schema.lessonProgress).values({ userId, lessonId, status }).run();
  }

  it("lists in-scope courses and defaults to the most-enrolled one", () => {
    const inst = makeInstructor();
    const small = makeCourse(inst.id, "Small");
    const big = makeCourse(inst.id, "Big");
    const s1 = makeStudent();
    const s2 = makeStudent();
    enroll(s1.id, small.id);
    enroll(s1.id, big.id);
    enroll(s2.id, big.id);

    const result = getContentAnalytics(inst.id, null);
    expect(result.courses).toEqual([
      { id: big.id, title: "Big", enrollmentCount: 2 },
      { id: small.id, title: "Small", enrollmentCount: 1 },
    ]);
    expect(result.selectedCourseId).toBe(big.id);
  });

  it("honours a requested in-scope course and ignores an out-of-scope one", () => {
    const inst = makeInstructor();
    const mine = makeCourse(inst.id, "Mine");
    const mine2 = makeCourse(inst.id, "Mine2");
    const theirs = makeCourse(makeInstructor().id, "Theirs");
    enroll(makeStudent().id, mine.id);

    expect(getContentAnalytics(inst.id, mine2.id).selectedCourseId).toBe(mine2.id);
    expect(getContentAnalytics(inst.id, theirs.id).selectedCourseId).toBe(mine.id);
  });

  it("returns a funnel in module-then-lesson order counting enrolled completions", () => {
    const c = makeCourse(base.instructor.id, "Funnel");
    const m2 = makeModule(c.id, 2);
    const m1 = makeModule(c.id, 1);
    const l2b = makeLesson(m2.id, "2b", 2);
    const l1a = makeLesson(m1.id, "1a", 1);
    const l2a = makeLesson(m2.id, "2a", 1);
    const s1 = makeStudent();
    const s2 = makeStudent();
    const outsider = makeStudent();
    enroll(s1.id, c.id);
    enroll(s2.id, c.id);
    progress(s1.id, l1a.id);
    progress(s2.id, l1a.id);
    progress(s1.id, l2a.id);
    progress(s2.id, l2a.id, schema.LessonProgressStatus.InProgress);
    progress(outsider.id, l2b.id);

    const result = getContentAnalytics(base.instructor.id, c.id);
    expect(result.enrolledStudents).toBe(2);
    expect(result.funnel).toEqual([
      { lessonId: l1a.id, title: "1a", completions: 2 },
      { lessonId: l2a.id, title: "2a", completions: 1 },
      { lessonId: l2b.id, title: "2b", completions: 0 },
    ]);
  });

  it("returns no selection when the scope has no courses", () => {
    expect(getContentAnalytics(makeInstructor().id, null)).toEqual({
      courses: [],
      selectedCourseId: null,
      enrolledStudents: 0,
      funnel: [],
    });
  });
});
