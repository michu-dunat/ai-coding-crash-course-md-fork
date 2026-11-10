import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
} from "~/db/schema";
import {
  getScopedCourseIds,
  type AnalyticsScope,
} from "~/services/instructorAnalytics/scope";

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
