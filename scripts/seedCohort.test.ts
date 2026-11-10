import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { seedCohort, type CohortCourse } from "./seedCohort";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function buildFixture() {
  const db = createTestDb();
  const { category, course } = seedBaseData(db);
  const instructor2 = db
    .insert(schema.users)
    .values({
      name: "Second",
      email: "i2@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
  const course2 = db
    .insert(schema.courses)
    .values({
      title: "Second Course",
      slug: "second-course",
      description: "d",
      salesCopy: "s",
      instructorId: instructor2.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price: 5000,
    })
    .returning()
    .get();

  const courses: CohortCourse[] = [];
  for (const c of [course, course2]) {
    const mod = db
      .insert(schema.modules)
      .values({ courseId: c.id, title: "M", position: 1 })
      .returning()
      .get();
    const lessonIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      lessonIds.push(
        db
          .insert(schema.lessons)
          .values({
            moduleId: mod.id,
            title: `L${i}`,
            position: i + 1,
            durationMinutes: 10,
          })
          .returning()
          .get().id
      );
    }
    const quiz = db
      .insert(schema.quizzes)
      .values({ lessonId: lessonIds[1], title: "Q", passingScore: 0.7 })
      .returning()
      .get();
    const options: CohortCourse["quizzes"][number]["options"] = [];
    for (let q = 0; q < 2; q++) {
      const question = db
        .insert(schema.quizQuestions)
        .values({
          quizId: quiz.id,
          questionText: `q${q}`,
          questionType: schema.QuestionType.TrueFalse,
          position: q + 1,
        })
        .returning()
        .get();
      for (const correct of [true, false]) {
        const opt = db
          .insert(schema.quizOptions)
          .values({
            questionId: question.id,
            optionText: String(correct),
            isCorrect: correct,
          })
          .returning()
          .get();
        options.push({ questionId: question.id, optionId: opt.id, correct });
      }
    }
    courses.push({
      id: c.id,
      price: c.price,
      instructorId: c.instructorId,
      lessonIds,
      quizzes: [{ id: quiz.id, passingScore: 0.7, options }],
    });
  }
  return { db, courses };
}

function dumpAll(db: ReturnType<typeof createTestDb>) {
  return {
    users: db
      .select()
      .from(schema.users)
      .all()
      .filter(
        (u) =>
          u.role === schema.UserRole.Student && u.email.endsWith("@cohort.dev")
      ),
    enrollments: db.select().from(schema.enrollments).all(),
    progress: db.select().from(schema.lessonProgress).all(),
    attempts: db.select().from(schema.quizAttempts).all(),
    answers: db.select().from(schema.quizAnswers).all(),
    events: db.select().from(schema.videoWatchEvents).all(),
    comments: db.select().from(schema.comments).all(),
    ratings: db.select().from(schema.courseRatings).all(),
    purchases: db.select().from(schema.purchases).all(),
    coupons: db.select().from(schema.coupons).all(),
  };
}

describe("seedCohort", () => {
  it("produces identical data on repeated runs", () => {
    const a = buildFixture();
    const b = buildFixture();
    seedCohort(a.db, { courses: a.courses, now: NOW });
    seedCohort(b.db, { courses: b.courses, now: NOW });
    expect(dumpAll(a.db)).toEqual(dumpAll(b.db));
  });

  it("adds 40 students enrolled across both instructors' courses", () => {
    const { db, courses } = buildFixture();
    const result = seedCohort(db, { courses, now: NOW });
    expect(result.studentIds).toHaveLength(40);
    const enrollments = db.select().from(schema.enrollments).all();
    for (const c of courses) {
      expect(
        enrollments.filter((e) => e.courseId === c.id).length
      ).toBeGreaterThan(5);
    }
  });

  it("spreads activity over 90 days with completed, active and at-risk students", () => {
    const { db, courses } = buildFixture();
    seedCohort(db, { courses, now: NOW });
    const enrollments = db.select().from(schema.enrollments).all();
    const progress = db.select().from(schema.lessonProgress).all();
    for (const e of enrollments) {
      const age = (NOW.getTime() - Date.parse(e.enrolledAt)) / DAY;
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(90);
    }
    const lessonCourse = new Map(
      courses.flatMap((c) => c.lessonIds.map((l) => [l, c.id] as const))
    );
    const lastActivity = (e: (typeof enrollments)[number]) =>
      Math.max(
        Date.parse(e.enrolledAt),
        ...progress
          .filter(
            (p) =>
              p.userId === e.userId &&
              lessonCourse.get(p.lessonId) === e.courseId &&
              p.completedAt
          )
          .map((p) => Date.parse(p.completedAt!))
      );
    const open = enrollments.filter((e) => !e.completedAt);
    const idleDays = (e: (typeof enrollments)[number]) =>
      (NOW.getTime() - lastActivity(e)) / DAY;
    expect(enrollments.filter((e) => e.completedAt).length).toBeGreaterThan(3);
    expect(open.filter((e) => idleDays(e) >= 14).length).toBeGreaterThan(3);
    expect(open.filter((e) => idleDays(e) < 7).length).toBeGreaterThan(3);
  });

  it("records quiz answers where some question is answered wrong often", () => {
    const { db, courses } = buildFixture();
    seedCohort(db, { courses, now: NOW });
    const answers = db.select().from(schema.quizAnswers).all();
    const options = db.select().from(schema.quizOptions).all();
    const correct = new Map(options.map((o) => [o.id, o.isCorrect]));
    const byQuestion = new Map<number, { wrong: number; total: number }>();
    for (const a of answers) {
      const s = byQuestion.get(a.questionId) ?? { wrong: 0, total: 0 };
      s.total++;
      if (!correct.get(a.selectedOptionId)) s.wrong++;
      byQuestion.set(a.questionId, s);
    }
    expect(answers.length).toBeGreaterThan(20);
    const rates = [...byQuestion.values()].map((s) => s.wrong / s.total);
    expect(Math.max(...rates)).toBeGreaterThan(0.4);
  });

  it("records watch events on multiple lessons with varying furthest positions", () => {
    const { db, courses } = buildFixture();
    seedCohort(db, { courses, now: NOW });
    const events = db.select().from(schema.videoWatchEvents).all();
    expect(new Set(events.map((e) => e.eventType))).toEqual(
      new Set(["play", "pause", "seek", "ended"])
    );
    const furthest = new Map<string, number>();
    for (const e of events) {
      const k = `${e.userId}:${e.lessonId}`;
      furthest.set(k, Math.max(furthest.get(k) ?? 0, e.positionSeconds));
    }
    expect(new Set(events.map((e) => e.lessonId)).size).toBeGreaterThan(2);
    expect(new Set(furthest.values()).size).toBeGreaterThan(5);
  });

  it("records purchases across countries and a partially redeemed team purchase", () => {
    const { db, courses } = buildFixture();
    seedCohort(db, { courses, now: NOW });
    const purchases = db.select().from(schema.purchases).all();
    expect(
      new Set(purchases.map((p) => p.country)).size
    ).toBeGreaterThanOrEqual(4);
    const coupons = db.select().from(schema.coupons).all();
    expect(coupons.some((c) => c.redeemedByUserId)).toBe(true);
    expect(coupons.some((c) => !c.redeemedByUserId)).toBe(true);
  });

  it("leaves some student questions unanswered and records ratings", () => {
    const { db, courses } = buildFixture();
    seedCohort(db, { courses, now: NOW });
    const comments = db.select().from(schema.comments).all();
    const topLevel = comments.filter((c) => c.parentId === null);
    const replied = new Set(comments.map((c) => c.parentId));
    expect(topLevel.some((c) => !replied.has(c.id))).toBe(true);
    expect(topLevel.some((c) => replied.has(c.id))).toBe(true);
    expect(db.select().from(schema.courseRatings).all().length).toBeGreaterThan(
      5
    );
  });
});
