import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessonFeedback,
  lessons,
  modules,
  courses,
  users,
  enrollments,
  UserRole,
} from "~/db/schema";
import { MAX_FEEDBACK_LENGTH, FEEDBACK_PAGE_SIZE } from "~/lib/feedback";

// ─── Lesson Feedback Service ───
// Private written feedback left by enrolled students on individual lessons.
// Visible only to the course's instructor and admins. One entry per student per
// lesson — submitting again updates the existing entry.
// Uses positional parameters (project convention).

export type CourseFeedbackEntry = {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  lessonId: number;
  lessonTitle: string;
  moduleId: number;
  moduleTitle: string;
  userId: number;
  userName: string;
  userAvatarUrl: string | null;
};

export type CourseFeedbackPage = {
  entries: CourseFeedbackEntry[];
  /** True when the first entry's lesson also had entries on the previous page. */
  continuesFromPreviousPage: boolean;
  page: number;
  totalPages: number;
  totalCount: number;
};

function normalizeContent(content: string) {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error("Feedback cannot be empty");
  }
  if (trimmed.length > MAX_FEEDBACK_LENGTH) {
    throw new Error(
      `Feedback must be at most ${MAX_FEEDBACK_LENGTH} characters`
    );
  }
  return trimmed;
}

/**
 * Throws unless the user is allowed to write (create/edit/delete) feedback on
 * the lesson: they must be enrolled, not an admin, and not the course's own
 * instructor.
 */
function assertCanWriteFeedback(userId: number, lessonId: number) {
  const lesson = db
    .select({ courseId: modules.courseId, instructorId: courses.instructorId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();

  if (!lesson) {
    throw new Error("Lesson not found");
  }

  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!user) {
    throw new Error("User not found");
  }
  if (user.role === UserRole.Admin) {
    throw new Error("Admins cannot leave feedback");
  }
  if (lesson.instructorId === userId) {
    throw new Error("Instructors cannot leave feedback on their own course");
  }

  const enrollment = db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, lesson.courseId)
      )
    )
    .get();

  if (!enrollment) {
    throw new Error("You must be enrolled in this course to leave feedback");
  }
}

/** Whether the user may write feedback on the lesson (used to show/hide the form). */
export function canLeaveFeedback(userId: number, lessonId: number) {
  try {
    assertCanWriteFeedback(userId, lessonId);
    return true;
  } catch {
    return false;
  }
}

export function getUserFeedbackForLesson(userId: number, lessonId: number) {
  return db
    .select()
    .from(lessonFeedback)
    .where(
      and(
        eq(lessonFeedback.userId, userId),
        eq(lessonFeedback.lessonId, lessonId)
      )
    )
    .get();
}

/**
 * Creates the user's feedback on a lesson, or updates it if they've already
 * left some. Returns the stored row.
 */
export function submitFeedback(
  userId: number,
  lessonId: number,
  content: string
) {
  const normalized = normalizeContent(content);
  assertCanWriteFeedback(userId, lessonId);

  return db
    .insert(lessonFeedback)
    .values({ userId, lessonId, content: normalized })
    .onConflictDoUpdate({
      target: [lessonFeedback.userId, lessonFeedback.lessonId],
      set: { content: normalized, updatedAt: new Date().toISOString() },
    })
    .returning()
    .get();
}

export function deleteFeedback(userId: number, lessonId: number) {
  assertCanWriteFeedback(userId, lessonId);

  return db
    .delete(lessonFeedback)
    .where(
      and(
        eq(lessonFeedback.userId, userId),
        eq(lessonFeedback.lessonId, lessonId)
      )
    )
    .returning()
    .get();
}

export function getFeedbackCountForCourse(courseId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonFeedback)
    .innerJoin(lessons, eq(lessonFeedback.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .get();
  return result?.count ?? 0;
}

/**
 * One page of a course's feedback, ordered by course structure (module, then
 * lesson position) and newest first within a lesson. Out-of-range or invalid
 * page numbers are clamped to the nearest valid page.
 */
export function getFeedbackForCourse(
  courseId: number,
  page: number
): CourseFeedbackPage {
  const totalCount = getFeedbackCountForCourse(courseId);
  const totalPages = Math.max(1, Math.ceil(totalCount / FEEDBACK_PAGE_SIZE));

  const requested = Number.isInteger(page) && page >= 1 ? page : 1;
  const currentPage = Math.min(requested, totalPages);

  if (totalCount === 0) {
    return {
      entries: [],
      continuesFromPreviousPage: false,
      page: currentPage,
      totalPages,
      totalCount,
    };
  }

  // Fetch one extra row from the end of the previous page so we can tell
  // whether this page's first lesson started there.
  const offset = (currentPage - 1) * FEEDBACK_PAGE_SIZE;
  const includePrevious = offset > 0;

  const rows = db
    .select({
      id: lessonFeedback.id,
      content: lessonFeedback.content,
      createdAt: lessonFeedback.createdAt,
      updatedAt: lessonFeedback.updatedAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      moduleId: modules.id,
      moduleTitle: modules.title,
      userId: users.id,
      userName: users.name,
      userAvatarUrl: users.avatarUrl,
    })
    .from(lessonFeedback)
    .innerJoin(lessons, eq(lessonFeedback.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(users, eq(lessonFeedback.userId, users.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(
      asc(modules.position),
      asc(modules.id),
      asc(lessons.position),
      asc(lessons.id),
      desc(lessonFeedback.createdAt),
      desc(lessonFeedback.id)
    )
    .limit(FEEDBACK_PAGE_SIZE + (includePrevious ? 1 : 0))
    .offset(includePrevious ? offset - 1 : 0)
    .all();

  const previous = includePrevious ? rows[0] : undefined;
  const entries = includePrevious ? rows.slice(1) : rows;
  const continuesFromPreviousPage =
    previous !== undefined &&
    entries.length > 0 &&
    previous.lessonId === entries[0].lessonId;

  return {
    entries,
    continuesFromPreviousPage,
    page: currentPage,
    totalPages,
    totalCount,
  };
}
