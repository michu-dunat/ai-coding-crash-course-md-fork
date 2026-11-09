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

// Import after mock so the module picks up our test db
import {
  setRating,
  removeRating,
  getUserRating,
  getCourseRatingSummary,
  getRatingSummariesForCourses,
} from "./ratingService";

function createStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

function createCourse(slug: string) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "desc",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

describe("ratingService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("setRating", () => {
    it("creates a rating for an enrolled student", () => {
      enroll(base.user.id, base.course.id);

      const rating = setRating(base.user.id, base.course.id, 4);

      expect(rating.userId).toBe(base.user.id);
      expect(rating.courseId).toBe(base.course.id);
      expect(rating.rating).toBe(4);
    });

    it("replaces an existing rating instead of adding a second one", () => {
      enroll(base.user.id, base.course.id);

      setRating(base.user.id, base.course.id, 2);
      setRating(base.user.id, base.course.id, 5);

      expect(getUserRating(base.user.id, base.course.id)?.rating).toBe(5);
      expect(getCourseRatingSummary(base.course.id).count).toBe(1);
    });

    it("throws when the user is not enrolled", () => {
      expect(() => setRating(base.user.id, base.course.id, 4)).toThrowError(
        "You must be enrolled to rate this course"
      );
    });

    it("throws when the instructor rates their own course", () => {
      enroll(base.instructor.id, base.course.id);

      expect(() =>
        setRating(base.instructor.id, base.course.id, 5)
      ).toThrowError("Instructors cannot rate their own course");
    });

    it.each([0, 6, 3.5, -1, Number.NaN])(
      "throws for invalid rating %s",
      (value) => {
        enroll(base.user.id, base.course.id);

        expect(() => setRating(base.user.id, base.course.id, value)).toThrowError(
          "Rating must be a whole number between 1 and 5"
        );
      }
    );

    it("accepts the boundary values 1 and 5", () => {
      enroll(base.user.id, base.course.id);

      expect(setRating(base.user.id, base.course.id, 1).rating).toBe(1);
      expect(setRating(base.user.id, base.course.id, 5).rating).toBe(5);
    });
  });

  describe("removeRating", () => {
    it("removes the user's rating", () => {
      enroll(base.user.id, base.course.id);
      setRating(base.user.id, base.course.id, 3);

      removeRating(base.user.id, base.course.id);

      expect(getUserRating(base.user.id, base.course.id)).toBeUndefined();
    });

    it("does nothing when there is no rating", () => {
      expect(() => removeRating(base.user.id, base.course.id)).not.toThrow();
    });
  });

  describe("getUserRating", () => {
    it("returns undefined when the user has not rated", () => {
      expect(getUserRating(base.user.id, base.course.id)).toBeUndefined();
    });
  });

  describe("getCourseRatingSummary", () => {
    it("returns null average and zero count when unrated", () => {
      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: null,
        count: 0,
      });
    });

    it("averages ratings across students", () => {
      const a = createStudent("a@example.com");
      const b = createStudent("b@example.com");
      enroll(a.id, base.course.id);
      enroll(b.id, base.course.id);
      setRating(a.id, base.course.id, 5);
      setRating(b.id, base.course.id, 2);

      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: 3.5,
        count: 2,
      });
    });
  });

  describe("getRatingSummariesForCourses", () => {
    it("returns a summary per course, including unrated courses", () => {
      const other = createCourse("other");
      enroll(base.user.id, base.course.id);
      setRating(base.user.id, base.course.id, 4);

      const summaries = getRatingSummariesForCourses([base.course.id, other.id]);

      expect(summaries.get(base.course.id)).toEqual({ average: 4, count: 1 });
      expect(summaries.get(other.id)).toEqual({ average: null, count: 0 });
    });

    it("returns an empty map for an empty list", () => {
      expect(getRatingSummariesForCourses([]).size).toBe(0);
    });
  });
});
