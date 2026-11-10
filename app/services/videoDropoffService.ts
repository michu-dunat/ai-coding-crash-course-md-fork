import { eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import { lessons, modules, videoWatchEvents } from "~/db/schema";

export type DropoffStep = {
  /** 10, 20, … 100 — share of the lesson duration */
  percent: number;
  /** 0–100 share of watching students whose furthest position reached this step */
  share: number;
};

export type LessonVideoDropoff = {
  lessonId: number;
  title: string;
  /** Distinct students with at least one watch event */
  watchers: number;
  /** null when the lesson has no duration set */
  steps: DropoffStep[] | null;
};

const STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/**
 * Video drop-off for a course's lessons that have watch events, in
 * module-then-lesson order. Each student's furthest position (any event type)
 * is bucketed into 10% steps of the duration; positions past the end count as 100%.
 */
export function getVideoDropoff(courseId: number): LessonVideoDropoff[] {
  const lessonRows = db
    .select({ lessonId: lessons.id, title: lessons.title, durationMinutes: lessons.durationMinutes })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position)
    .all();
  if (lessonRows.length === 0) return [];

  const events = db
    .select({
      userId: videoWatchEvents.userId,
      lessonId: videoWatchEvents.lessonId,
      positionSeconds: videoWatchEvents.positionSeconds,
    })
    .from(videoWatchEvents)
    .where(inArray(videoWatchEvents.lessonId, lessonRows.map((l) => l.lessonId)))
    .all();

  const furthest = new Map<number, Map<number, number>>();
  for (const e of events) {
    let perUser = furthest.get(e.lessonId);
    if (!perUser) furthest.set(e.lessonId, (perUser = new Map()));
    perUser.set(e.userId, Math.max(perUser.get(e.userId) ?? 0, e.positionSeconds));
  }

  return lessonRows.flatMap((l): LessonVideoDropoff[] => {
    const perUser = furthest.get(l.lessonId);
    if (!perUser) return [];
    const watchers = perUser.size;
    if (!l.durationMinutes) {
      return [{ lessonId: l.lessonId, title: l.title, watchers, steps: null }];
    }
    const durationSeconds = l.durationMinutes * 60;
    const buckets = [...perUser.values()].map((pos) =>
      Math.min(100, Math.floor((pos / durationSeconds) * 10) * 10)
    );
    const steps = STEPS.map((percent) => ({
      percent,
      share: (buckets.filter((b) => b >= percent).length / watchers) * 100,
    }));
    return [{ lessonId: l.lessonId, title: l.title, watchers, steps }];
  });
}
