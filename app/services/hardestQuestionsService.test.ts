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

import { getHardestQuestions } from "~/services/hardestQuestionsService";

let n = 0;
beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

function makeCourse() {
  return testDb
    .insert(schema.courses)
    .values({
      title: "C",
      slug: `hq-${++n}`,
      description: "d",
      salesCopy: "s",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}
function makeLesson(courseId: number, title: string) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "M", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title, position: 1 })
    .returning()
    .get();
}
function makeQuestion(lessonId: number, text: string) {
  const quiz = testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Q", passingScore: 0.5 })
    .returning()
    .get();
  const question = testDb
    .insert(schema.quizQuestions)
    .values({
      quizId: quiz.id,
      questionText: text,
      questionType: schema.QuestionType.MultipleChoice,
      position: 1,
    })
    .returning()
    .get();
  const [right, wrong] = [true, false].map((isCorrect) =>
    testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText: String(isCorrect), isCorrect })
      .returning()
      .get()
  );
  return { quiz, question, right, wrong };
}
/** Records answers, each in its own attempt; `true` = correct. */
function answer(q: ReturnType<typeof makeQuestion>, results: boolean[]) {
  for (const correct of results) {
    const attempt = testDb
      .insert(schema.quizAttempts)
      .values({ userId: base.user.id, quizId: q.quiz.id, score: 0, passed: false })
      .returning()
      .get();
    testDb
      .insert(schema.quizAnswers)
      .values({
        attemptId: attempt.id,
        questionId: q.question.id,
        selectedOptionId: correct ? q.right.id : q.wrong.id,
      })
      .run();
  }
}

describe("getHardestQuestions", () => {
  it("computes the wrong-answer rate across all attempts", () => {
    const course = makeCourse();
    const lesson = makeLesson(course.id, "Intro");
    const q = makeQuestion(lesson.id, "What is 2+2?");
    answer(q, [false, false, false, true]);

    expect(getHardestQuestions(base.instructor.id, course.id)).toEqual([
      {
        questionId: q.question.id,
        questionText: "What is 2+2?",
        lessonTitle: "Intro",
        wrongRate: 75,
        answerCount: 4,
      },
    ]);
  });

  it("excludes questions with fewer than 3 answers and other courses", () => {
    const course = makeCourse();
    const lesson = makeLesson(course.id, "L");
    const few = makeQuestion(lesson.id, "Few");
    answer(few, [false, false]);
    const enough = makeQuestion(lesson.id, "Enough");
    answer(enough, [true, true, true]);
    const elsewhere = makeQuestion(makeLesson(makeCourse().id, "X").id, "Elsewhere");
    answer(elsewhere, [false, false, false]);

    expect(getHardestQuestions(base.instructor.id, course.id).map((q) => q.questionText)).toEqual(["Enough"]);
  });

  it("orders by wrong-answer rate, highest first", () => {
    const course = makeCourse();
    const lesson = makeLesson(course.id, "L");
    answer(makeQuestion(lesson.id, "Easy"), [true, true, true]);
    answer(makeQuestion(lesson.id, "Hard"), [false, false, false]);
    answer(makeQuestion(lesson.id, "Medium"), [false, true, true]);

    expect(getHardestQuestions(base.instructor.id, course.id).map((q) => q.questionText)).toEqual([
      "Hard",
      "Medium",
      "Easy",
    ]);
  });

  it("returns at most 10 questions", () => {
    const course = makeCourse();
    const lesson = makeLesson(course.id, "L");
    // Q0 has 0 wrong of 12, Q11 has 11 wrong of 12
    for (let i = 0; i < 12; i++) {
      answer(
        makeQuestion(lesson.id, `Q${i}`),
        Array.from({ length: 12 }, (_, j) => j >= i)
      );
    }

    expect(getHardestQuestions(base.instructor.id, course.id).map((q) => q.questionText)).toEqual(
      ["Q11", "Q10", "Q9", "Q8", "Q7", "Q6", "Q5", "Q4", "Q3", "Q2"]
    );
  });

  it("returns nothing for a course outside the scope", () => {
    const course = makeCourse();
    answer(makeQuestion(makeLesson(course.id, "L").id, "Hard"), [false, false, false]);
    const outsider = testDb
      .insert(schema.users)
      .values({ name: "Other", email: "other-hq@x.com", role: schema.UserRole.Instructor })
      .returning()
      .get();

    expect(getHardestQuestions(outsider.id, course.id)).toEqual([]);
    expect(getHardestQuestions("all", course.id)).toHaveLength(1);
  });
});
