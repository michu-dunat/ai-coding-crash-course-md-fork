import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { and, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { MAX_FEEDBACK_LENGTH, FEEDBACK_PAGE_SIZE } from "~/lib/feedback";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the modules pick up our test db
import {
  submitFeedback,
  canLeaveFeedback,
  getUserFeedbackForLesson,
  deleteFeedback,
  getFeedbackForCourse,
  getFeedbackCountForCourse,
} from "./lessonFeedbackService";
import { deleteLesson } from "./lessonService";
import { deleteModule } from "./moduleService";

function createUser(name: string, email: string, role = schema.UserRole.Student) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

function createModule(courseId: number, title: string, position: number) {
  return testDb
    .insert(schema.modules)
    .values({ courseId, title, position })
    .returning()
    .get();
}

function createLesson(moduleId: number, title: string, position: number) {
  return testDb
    .insert(schema.lessons)
    .values({ moduleId, title, position })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId })
    .returning()
    .get();
}

function unenroll(userId: number, courseId: number) {
  testDb
    .delete(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, courseId)
      )
    )
    .run();
}

describe("lessonFeedbackService", () => {
  let mod: ReturnType<typeof createModule>;
  let lesson: ReturnType<typeof createLesson>;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    mod = createModule(base.course.id, "Module 1", 1);
    lesson = createLesson(mod.id, "Lesson 1", 1);
    enroll(base.user.id, base.course.id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("submitFeedback", () => {
    it("stores trimmed feedback for an enrolled student", () => {
      const feedback = submitFeedback(base.user.id, lesson.id, "  Great lesson!  ");

      expect(feedback.userId).toBe(base.user.id);
      expect(feedback.lessonId).toBe(lesson.id);
      expect(feedback.content).toBe("Great lesson!");
    });

    it("keeps line breaks inside the text", () => {
      const feedback = submitFeedback(base.user.id, lesson.id, "Line one\nLine two");
      expect(feedback.content).toBe("Line one\nLine two");
    });

    it("updates the existing feedback instead of adding a second entry", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      const first = submitFeedback(base.user.id, lesson.id, "First take");

      vi.setSystemTime(new Date("2026-01-02T10:00:00.000Z"));
      const updated = submitFeedback(base.user.id, lesson.id, "Second take");

      expect(updated.id).toBe(first.id);
      expect(updated.content).toBe("Second take");
      expect(updated.createdAt).toBe("2026-01-01T10:00:00.000Z");
      expect(updated.updatedAt).toBe("2026-01-02T10:00:00.000Z");
      expect(getFeedbackCountForCourse(base.course.id)).toBe(1);
    });

    it.each(["", "   ", "\n\t "])("rejects empty feedback %j", (content) => {
      expect(() => submitFeedback(base.user.id, lesson.id, content)).toThrowError(
        "Feedback cannot be empty"
      );
    });

    it("accepts feedback at the maximum length", () => {
      const content = "a".repeat(MAX_FEEDBACK_LENGTH);
      expect(submitFeedback(base.user.id, lesson.id, content).content).toBe(content);
    });

    it("rejects feedback over the maximum length", () => {
      const content = "a".repeat(MAX_FEEDBACK_LENGTH + 1);
      expect(() => submitFeedback(base.user.id, lesson.id, content)).toThrowError(
        `Feedback must be at most ${MAX_FEEDBACK_LENGTH} characters`
      );
    });

    it("measures length after trimming", () => {
      const content = `  ${"a".repeat(MAX_FEEDBACK_LENGTH)}  `;
      expect(() => submitFeedback(base.user.id, lesson.id, content)).not.toThrow();
    });

    it("rejects a lesson that does not exist", () => {
      expect(() => submitFeedback(base.user.id, 9999, "Hello")).toThrowError(
        "Lesson not found"
      );
    });

    it("rejects a student who is not enrolled", () => {
      const other = createUser("Other", "other@example.com");
      expect(() => submitFeedback(other.id, lesson.id, "Hello")).toThrowError(
        "You must be enrolled in this course to leave feedback"
      );
    });

    it("rejects the course's own instructor even if enrolled", () => {
      enroll(base.instructor.id, base.course.id);
      expect(() =>
        submitFeedback(base.instructor.id, lesson.id, "Hello")
      ).toThrowError("Instructors cannot leave feedback on their own course");
    });

    it("rejects admins even if enrolled", () => {
      const admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
      enroll(admin.id, base.course.id);
      expect(() => submitFeedback(admin.id, lesson.id, "Hello")).toThrowError(
        "Admins cannot leave feedback"
      );
    });

    it("allows an instructor of another course who is enrolled as a student", () => {
      const otherInstructor = createUser(
        "Other Instructor",
        "oi@example.com",
        schema.UserRole.Instructor
      );
      enroll(otherInstructor.id, base.course.id);
      expect(
        submitFeedback(otherInstructor.id, lesson.id, "Nice").content
      ).toBe("Nice");
    });

    it("rejects edits once the student is no longer enrolled", () => {
      submitFeedback(base.user.id, lesson.id, "Original");
      unenroll(base.user.id, base.course.id);

      expect(() => submitFeedback(base.user.id, lesson.id, "Edited")).toThrowError(
        "You must be enrolled in this course to leave feedback"
      );
      expect(getUserFeedbackForLesson(base.user.id, lesson.id)?.content).toBe(
        "Original"
      );
    });
  });

  describe("canLeaveFeedback", () => {
    it("is true for an enrolled student", () => {
      expect(canLeaveFeedback(base.user.id, lesson.id)).toBe(true);
    });

    it("is false for a student who is not enrolled", () => {
      const other = createUser("Other", "other@example.com");
      expect(canLeaveFeedback(other.id, lesson.id)).toBe(false);
    });

    it("is false for the course's own instructor", () => {
      enroll(base.instructor.id, base.course.id);
      expect(canLeaveFeedback(base.instructor.id, lesson.id)).toBe(false);
    });

    it("is false for an admin", () => {
      const admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
      enroll(admin.id, base.course.id);
      expect(canLeaveFeedback(admin.id, lesson.id)).toBe(false);
    });

    it("is false for a lesson that does not exist", () => {
      expect(canLeaveFeedback(base.user.id, 9999)).toBe(false);
    });
  });

  describe("getUserFeedbackForLesson", () => {
    it("returns undefined when the user has not left feedback", () => {
      expect(getUserFeedbackForLesson(base.user.id, lesson.id)).toBeUndefined();
    });

    it("returns the user's feedback for the lesson", () => {
      submitFeedback(base.user.id, lesson.id, "Helpful");
      expect(getUserFeedbackForLesson(base.user.id, lesson.id)?.content).toBe(
        "Helpful"
      );
    });
  });

  describe("deleteFeedback", () => {
    it("removes the user's feedback", () => {
      submitFeedback(base.user.id, lesson.id, "Helpful");
      const deleted = deleteFeedback(base.user.id, lesson.id);

      expect(deleted?.content).toBe("Helpful");
      expect(getUserFeedbackForLesson(base.user.id, lesson.id)).toBeUndefined();
    });

    it("only removes the given user's feedback", () => {
      const other = createUser("Other", "other@example.com");
      enroll(other.id, base.course.id);
      submitFeedback(base.user.id, lesson.id, "Mine");
      submitFeedback(other.id, lesson.id, "Theirs");

      deleteFeedback(base.user.id, lesson.id);

      expect(getUserFeedbackForLesson(other.id, lesson.id)?.content).toBe("Theirs");
    });

    it("rejects deletes once the student is no longer enrolled", () => {
      submitFeedback(base.user.id, lesson.id, "Original");
      unenroll(base.user.id, base.course.id);

      expect(() => deleteFeedback(base.user.id, lesson.id)).toThrowError(
        "You must be enrolled in this course to leave feedback"
      );
    });
  });

  describe("getFeedbackForCourse", () => {
    it("returns an empty first page when there is no feedback", () => {
      const result = getFeedbackForCourse(base.course.id, 1);

      expect(result.entries).toEqual([]);
      expect(result.continuesFromPreviousPage).toBe(false);
      expect(result.totalCount).toBe(0);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it("includes lesson, module, and student details", () => {
      submitFeedback(base.user.id, lesson.id, "Helpful");
      const [entry] = getFeedbackForCourse(base.course.id, 1).entries;

      expect(entry).toMatchObject({
        content: "Helpful",
        lessonId: lesson.id,
        lessonTitle: "Lesson 1",
        moduleId: mod.id,
        moduleTitle: "Module 1",
        userId: base.user.id,
        userName: "Test User",
      });
    });

    it("orders by module position, lesson position, then newest first", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const mod2 = createModule(base.course.id, "Module 2", 2);
      const m2l1 = createLesson(mod2.id, "M2 Lesson 1", 1);
      const lesson2 = createLesson(mod.id, "Lesson 2", 2);
      const s2 = createUser("S2", "s2@example.com");
      enroll(s2.id, base.course.id);

      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      submitFeedback(base.user.id, m2l1.id, "m2l1 old");
      vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
      submitFeedback(base.user.id, lesson2.id, "l2");
      vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
      submitFeedback(base.user.id, lesson.id, "l1 old");
      vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
      submitFeedback(s2.id, lesson.id, "l1 new");
      submitFeedback(s2.id, m2l1.id, "m2l1 new");

      const contents = getFeedbackForCourse(base.course.id, 1).entries.map(
        (e) => e.content
      );
      expect(contents).toEqual(["l1 new", "l1 old", "l2", "m2l1 new", "m2l1 old"]);
    });

    it("excludes feedback from other courses", () => {
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other",
          slug: "other",
          description: "Other",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      const otherMod = createModule(otherCourse.id, "Other module", 1);
      const otherLesson = createLesson(otherMod.id, "Other lesson", 1);
      enroll(base.user.id, otherCourse.id);
      submitFeedback(base.user.id, otherLesson.id, "Elsewhere");

      expect(getFeedbackForCourse(base.course.id, 1).totalCount).toBe(0);
      expect(getFeedbackCountForCourse(otherCourse.id)).toBe(1);
    });

    describe("paging", () => {
      const total = FEEDBACK_PAGE_SIZE * 2 + 5;

      beforeEach(() => {
        for (let i = 0; i < total; i++) {
          const student = createUser(`S${i}`, `s${i}@example.com`);
          enroll(student.id, base.course.id);
          submitFeedback(student.id, lesson.id, `Feedback ${i}`);
        }
      });

      it("returns one page of entries with totals", () => {
        const result = getFeedbackForCourse(base.course.id, 1);

        expect(result.entries).toHaveLength(FEEDBACK_PAGE_SIZE);
        expect(result.totalCount).toBe(total);
        expect(result.totalPages).toBe(3);
        expect(result.page).toBe(1);
      });

      it("returns the remainder on the last page", () => {
        const result = getFeedbackForCourse(base.course.id, 3);
        expect(result.entries).toHaveLength(5);
        expect(result.page).toBe(3);
      });

      it("does not repeat entries across pages", () => {
        const ids = [1, 2, 3].flatMap((p) =>
          getFeedbackForCourse(base.course.id, p).entries.map((e) => e.id)
        );
        expect(new Set(ids).size).toBe(total);
      });

      it("clamps a page past the end to the last page", () => {
        const result = getFeedbackForCourse(base.course.id, 99);
        expect(result.page).toBe(3);
        expect(result.entries).toHaveLength(5);
      });

      it("flags when the first lesson on a page continues from the previous page", () => {
        expect(getFeedbackForCourse(base.course.id, 1).continuesFromPreviousPage).toBe(false);
        expect(getFeedbackForCourse(base.course.id, 2).continuesFromPreviousPage).toBe(true);
      });

      it("does not flag continuation when a page starts on a new lesson", () => {
        // Move the newest-sorted lesson boundary so page 2 starts a new lesson:
        // put exactly one page of feedback on lesson 1 and the rest on lesson 2.
        testDb.delete(schema.lessonFeedback).run();
        const lesson2 = createLesson(mod.id, "Lesson 2", 2);
        for (let i = 0; i < FEEDBACK_PAGE_SIZE + 3; i++) {
          const student = createUser(`T${i}`, `t${i}@example.com`);
          enroll(student.id, base.course.id);
          submitFeedback(
            student.id,
            i < FEEDBACK_PAGE_SIZE ? lesson.id : lesson2.id,
            `Feedback ${i}`
          );
        }

        const page2 = getFeedbackForCourse(base.course.id, 2);
        expect(page2.entries[0].lessonId).toBe(lesson2.id);
        expect(page2.continuesFromPreviousPage).toBe(false);
      });

      it.each([0, -2, Number.NaN, 1.5])("treats page %s as page 1", (page) => {
        const result = getFeedbackForCourse(base.course.id, page);
        expect(result.page).toBe(1);
        expect(result.entries).toHaveLength(FEEDBACK_PAGE_SIZE);
      });
    });
  });

  describe("getFeedbackCountForCourse", () => {
    it("counts feedback across all lessons in the course", () => {
      const lesson2 = createLesson(mod.id, "Lesson 2", 2);
      submitFeedback(base.user.id, lesson.id, "One");
      submitFeedback(base.user.id, lesson2.id, "Two");

      expect(getFeedbackCountForCourse(base.course.id)).toBe(2);
    });
  });

  describe("deleting lessons and modules", () => {
    it("deleteLesson removes the lesson's feedback first", () => {
      submitFeedback(base.user.id, lesson.id, "Bye");

      expect(() => deleteLesson(lesson.id)).not.toThrow();
      expect(getFeedbackCountForCourse(base.course.id)).toBe(0);
    });

    it("deleteModule removes feedback on the module's lessons first", () => {
      submitFeedback(base.user.id, lesson.id, "Bye");

      expect(() => deleteModule(mod.id)).not.toThrow();
      expect(getFeedbackCountForCourse(base.course.id)).toBe(0);
    });
  });
});
