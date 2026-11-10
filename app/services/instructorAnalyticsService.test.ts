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

import {
  getOverviewStats,
  getCourseBreakdown,
  getOverviewRating,
  getUnansweredQuestionCount,
} from "~/services/instructorAnalyticsService";

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

describe("Overview details", () => {
  let n = 0;
  function user(role: schema.UserRole = schema.UserRole.Student) {
    return testDb
      .insert(schema.users)
      .values({ name: `U${++n}`, email: `o${n}@x.com`, role })
      .returning()
      .get();
  }
  function course(instructorId: number, title: string, status = schema.CourseStatus.Published) {
    return testDb
      .insert(schema.courses)
      .values({
        title,
        slug: `oc-${++n}`,
        description: "d",
        salesCopy: "s",
        instructorId,
        categoryId: base.category.id,
        status,
      })
      .returning()
      .get();
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
  function enroll(userId: number, courseId: number, completedAt: string | null = null) {
    testDb
      .insert(schema.enrollments)
      .values({ userId, courseId, enrolledAt: "2026-05-01T00:00:00.000Z", completedAt })
      .run();
  }
  function complete(userId: number, lessonId: number) {
    testDb
      .insert(schema.lessonProgress)
      .values({ userId, lessonId, status: schema.LessonProgressStatus.Completed })
      .run();
  }
  function rate(userId: number, courseId: number, rating: number) {
    testDb.insert(schema.courseRatings).values({ userId, courseId, rating }).run();
  }

  describe("getCourseBreakdown", () => {
    it("lists every in-scope course with enrollments, progress, completion and rating", () => {
      const inst = user(schema.UserRole.Instructor);
      const a = course(inst.id, "Alpha");
      const b = course(inst.id, "Beta", schema.CourseStatus.Archived);
      course(inst.id, "Draft", schema.CourseStatus.Draft);
      const l1 = lessonIn(a.id);
      lessonIn(a.id);
      const s1 = user();
      const s2 = user();
      enroll(s1.id, a.id, "2026-05-10T00:00:00.000Z");
      enroll(s2.id, a.id);
      complete(s1.id, l1.id);
      rate(s1.id, a.id, 5);
      rate(s2.id, a.id, 4);

      expect(getCourseBreakdown(inst.id)).toEqual([
        {
          courseId: a.id,
          title: "Alpha",
          enrollments: 2,
          averageProgress: 25,
          completionRate: 50,
          averageRating: 4.5,
          ratingCount: 2,
        },
        {
          courseId: b.id,
          title: "Beta",
          enrollments: 0,
          averageProgress: 0,
          completionRate: 0,
          averageRating: null,
          ratingCount: 0,
        },
      ]);
    });

    it("isolates instructors, and 'all' includes every instructor's courses", () => {
      const i1 = user(schema.UserRole.Instructor);
      const i2 = user(schema.UserRole.Instructor);
      const a = course(i1.id, "A");
      const b = course(i2.id, "B");
      expect(getCourseBreakdown(i1.id).map((r) => r.courseId)).toEqual([a.id]);
      const all = getCourseBreakdown("all").map((r) => r.courseId);
      expect(all).toContain(a.id);
      expect(all).toContain(b.id);
    });
  });

  describe("getOverviewRating", () => {
    it("averages every rating across in-scope courses, ignoring drafts", () => {
      const inst = user(schema.UserRole.Instructor);
      const a = course(inst.id, "A");
      const b = course(inst.id, "B");
      const draft = course(inst.id, "D", schema.CourseStatus.Draft);
      rate(user().id, a.id, 5);
      rate(user().id, a.id, 5);
      rate(user().id, b.id, 2);
      rate(user().id, draft.id, 1);
      expect(getOverviewRating(inst.id)).toEqual({ average: 4, count: 3 });
    });

    it("returns a null average when nothing is rated", () => {
      const inst = user(schema.UserRole.Instructor);
      course(inst.id, "A");
      expect(getOverviewRating(inst.id)).toEqual({ average: null, count: 0 });
    });

    it("combines instructors for 'all'", () => {
      const i1 = user(schema.UserRole.Instructor);
      const i2 = user(schema.UserRole.Instructor);
      rate(user().id, course(i1.id, "A").id, 4);
      rate(user().id, course(i2.id, "B").id, 2);
      expect(getOverviewRating("all")).toEqual({ average: 3, count: 2 });
    });
  });

  describe("getUnansweredQuestionCount", () => {
    function ask(lessonId: number, userId: number) {
      return testDb
        .insert(schema.comments)
        .values({ lessonId, userId, body: "?" })
        .returning()
        .get();
    }

    it("counts unanswered questions on in-scope courses for one instructor and for 'all'", () => {
      const i1 = user(schema.UserRole.Instructor);
      const i2 = user(schema.UserRole.Instructor);
      const l1 = lessonIn(course(i1.id, "A").id);
      const l2 = lessonIn(course(i2.id, "B").id);
      const lDraft = lessonIn(course(i1.id, "D", schema.CourseStatus.Draft).id);
      const s = user();
      ask(l1.id, s.id);
      const answered = ask(l1.id, s.id);
      testDb
        .insert(schema.comments)
        .values({ lessonId: l1.id, userId: i1.id, body: "a", parentId: answered.id })
        .run();
      ask(l2.id, s.id);
      ask(lDraft.id, s.id);

      expect(getUnansweredQuestionCount(i1.id)).toBe(1);
      expect(getUnansweredQuestionCount(i2.id)).toBe(1);
      expect(getUnansweredQuestionCount("all")).toBe(2);
    });
  });
});
