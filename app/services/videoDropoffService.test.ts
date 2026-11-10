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

import { getVideoDropoff } from "~/services/videoDropoffService";

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
      slug: `vd-${++n}`,
      description: "d",
      salesCopy: "s",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}
function makeLesson(courseId: number, title: string, durationMinutes: number | null, position = 1) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "M", position })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title, position: 1, durationMinutes })
    .returning()
    .get();
}
function makeStudent(enrolledInCourseId?: number) {
  const user = testDb
    .insert(schema.users)
    .values({ name: "S", email: `vd${++n}@x.com`, role: schema.UserRole.Student })
    .returning()
    .get();
  if (enrolledInCourseId !== undefined) {
    testDb.insert(schema.enrollments).values({ userId: user.id, courseId: enrolledInCourseId }).run();
  }
  return user;
}
function watch(userId: number, lessonId: number, positionSeconds: number, eventType = "progress") {
  testDb.insert(schema.videoWatchEvents).values({ userId, lessonId, positionSeconds, eventType }).run();
}

describe("getVideoDropoff", () => {
  it("returns every lesson, with zero watchers when nobody has watched", () => {
    const c = makeCourse();
    const l = makeLesson(c.id, "L", 10);
    const unwatchedNoDuration = makeLesson(c.id, "No dur", null, 2);
    expect(getVideoDropoff(base.instructor.id, c.id)).toEqual([
      {
        lessonId: l.id,
        title: "L",
        watchers: 0,
        steps: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((percent) => ({ percent, share: 0 })),
      },
      { lessonId: unwatchedNoDuration.id, title: "No dur", watchers: 0, steps: null },
    ]);
  });

  it("counts only enrolled students as watchers", () => {
    const c = makeCourse();
    const l = makeLesson(c.id, "L", 1);
    watch(makeStudent(c.id).id, l.id, 60);
    watch(makeStudent().id, l.id, 6);
    const [row] = getVideoDropoff(base.instructor.id, c.id);
    expect(row.watchers).toBe(1);
    expect(row.steps!.at(-1)).toEqual({ percent: 100, share: 100 });
  });

  it("returns nothing for a course outside the scope", () => {
    const c = makeCourse();
    const l = makeLesson(c.id, "L", 1);
    watch(makeStudent(c.id).id, l.id, 60);
    const outsider = makeStudent();
    expect(getVideoDropoff(outsider.id, c.id)).toEqual([]);
    expect(getVideoDropoff("all", c.id)).toHaveLength(1);
  });

  it("buckets each student's furthest position into 10% steps, regardless of event type", () => {
    const c = makeCourse();
    const l = makeLesson(c.id, "L", 10); // 600s
    const a = makeStudent(c.id);
    const b = makeStudent(c.id);
    // a: furthest 330s (55%) via a pause; a later, earlier-position play is ignored
    watch(a.id, l.id, 330, "pause");
    watch(a.id, l.id, 60, "play");
    // b: furthest 125s (~20.8%)
    watch(b.id, l.id, 125, "seek");
    const [row] = getVideoDropoff(base.instructor.id, c.id);
    expect(row.lessonId).toBe(l.id);
    expect(row.watchers).toBe(2);
    expect(row.steps).toEqual([
      { percent: 10, share: 100 },
      { percent: 20, share: 100 },
      { percent: 30, share: 50 },
      { percent: 40, share: 50 },
      { percent: 50, share: 50 },
      { percent: 60, share: 0 },
      { percent: 70, share: 0 },
      { percent: 80, share: 0 },
      { percent: 90, share: 0 },
      { percent: 100, share: 0 },
    ]);
  });

  it("counts positions beyond the duration as 100%", () => {
    const c = makeCourse();
    const l = makeLesson(c.id, "L", 1); // 60s
    watch(makeStudent(c.id).id, l.id, 999);
    const [row] = getVideoDropoff(base.instructor.id, c.id);
    expect(row.steps!.at(-1)).toEqual({ percent: 100, share: 100 });
  });

  it("marks watched lessons without a duration instead of charting them", () => {
    const c = makeCourse();
    const l = makeLesson(c.id, "No dur", null);
    watch(makeStudent(c.id).id, l.id, 30);
    expect(getVideoDropoff(base.instructor.id, c.id)).toEqual([
      { lessonId: l.id, title: "No dur", watchers: 1, steps: null },
    ]);
  });

  it("ignores other courses' lessons and orders by module then lesson", () => {
    const c = makeCourse();
    const other = makeCourse();
    const second = makeLesson(c.id, "Second", 5, 2);
    const first = makeLesson(c.id, "First", 5, 1);
    const foreign = makeLesson(other.id, "Foreign", 5);
    const s = makeStudent(c.id);
    watch(s.id, second.id, 10);
    watch(s.id, first.id, 10);
    watch(s.id, foreign.id, 10);
    expect(getVideoDropoff(base.instructor.id, c.id).map((r) => r.title)).toEqual(["First", "Second"]);
  });
});
