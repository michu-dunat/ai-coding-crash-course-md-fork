import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "~/db";
import { courseRatings, courses, enrollments } from "~/db/schema";

// ─── Rating Service ───
// Handles 1–5 star course ratings: one rating per student per course,
// which the student can change or remove.
// Uses positional parameters (project convention).

export type RatingSummary = { average: number | null; count: number };

export function getUserRating(userId: number, courseId: number) {
  return db
    .select()
    .from(courseRatings)
    .where(
      and(eq(courseRatings.userId, userId), eq(courseRatings.courseId, courseId))
    )
    .get();
}

export function setRating(userId: number, courseId: number, rating: number) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Rating must be a whole number between 1 and 5");
  }

  const course = db
    .select({ instructorId: courses.instructorId })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) {
    throw new Error("Course not found");
  }
  if (course.instructorId === userId) {
    throw new Error("Instructors cannot rate their own course");
  }

  const enrollment = db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
  if (!enrollment) {
    throw new Error("You must be enrolled to rate this course");
  }

  const now = new Date().toISOString();
  return db
    .insert(courseRatings)
    .values({ userId, courseId, rating, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [courseRatings.userId, courseRatings.courseId],
      set: { rating, updatedAt: now },
    })
    .returning()
    .get();
}

export function removeRating(userId: number, courseId: number) {
  db.delete(courseRatings)
    .where(
      and(eq(courseRatings.userId, userId), eq(courseRatings.courseId, courseId))
    )
    .run();
}

export function getCourseRatingSummary(courseId: number): RatingSummary {
  return (
    getRatingSummariesForCourses([courseId]).get(courseId) ?? {
      average: null,
      count: 0,
    }
  );
}

export function getRatingSummariesForCourses(
  courseIds: number[]
): Map<number, RatingSummary> {
  const summaries = new Map<number, RatingSummary>();
  if (courseIds.length === 0) return summaries;

  for (const id of courseIds) {
    summaries.set(id, { average: null, count: 0 });
  }

  const rows = db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .where(inArray(courseRatings.courseId, courseIds))
    .groupBy(courseRatings.courseId)
    .all();

  for (const row of rows) {
    summaries.set(row.courseId, { average: row.average, count: row.count });
  }

  return summaries;
}
