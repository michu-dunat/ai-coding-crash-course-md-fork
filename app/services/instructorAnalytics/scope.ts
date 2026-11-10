import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  CourseStatus,
} from "~/db/schema";

/** A single instructor id, or "all" for platform-wide data. */
export type AnalyticsScope = number | "all";

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

export function getScopedCourseIds(scope: AnalyticsScope): number[] {
  const statusFilter = inArray(courses.status, INCLUDED_STATUSES);
  return db
    .select({ id: courses.id })
    .from(courses)
    .where(
      scope === "all"
        ? statusFilter
        : and(statusFilter, eq(courses.instructorId, scope))
    )
    .all()
    .map((c) => c.id);
}

export function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}
