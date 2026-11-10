import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  lessons,
  modules,
  quizAnswers,
  quizOptions,
  quizQuestions,
  quizzes,
} from "~/db/schema";

export type HardQuestion = {
  questionId: number;
  questionText: string;
  lessonTitle: string;
  /** 0–100, wrong answers / total answers across all attempts */
  wrongRate: number;
  answerCount: number;
};

const MIN_ANSWERS = 3;
const LIMIT = 10;

/**
 * The hardest quiz questions in a course: highest wrong-answer rate first,
 * across all attempts.
 */
export function getHardestQuestions(courseId: number): HardQuestion[] {
  const rows = db
    .select({
      questionId: quizQuestions.id,
      questionText: quizQuestions.questionText,
      lessonTitle: lessons.title,
      isCorrect: quizOptions.isCorrect,
    })
    .from(quizAnswers)
    .innerJoin(quizOptions, eq(quizAnswers.selectedOptionId, quizOptions.id))
    .innerJoin(quizQuestions, eq(quizAnswers.questionId, quizQuestions.id))
    .innerJoin(quizzes, eq(quizQuestions.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all();

  const stats = new Map<number, { row: (typeof rows)[number]; wrong: number; total: number }>();
  for (const r of rows) {
    const s = stats.get(r.questionId) ?? { row: r, wrong: 0, total: 0 };
    s.total++;
    if (!r.isCorrect) s.wrong++;
    stats.set(r.questionId, s);
  }

  return [...stats.values()]
    .filter((s) => s.total >= MIN_ANSWERS)
    .sort((a, b) => b.wrong / b.total - a.wrong / a.total || b.total - a.total)
    .slice(0, LIMIT)
    .map(({ row, wrong, total }) => ({
    questionId: row.questionId,
    questionText: row.questionText,
    lessonTitle: row.lessonTitle,
    wrongRate: (wrong / total) * 100,
    answerCount: total,
  }));
}
