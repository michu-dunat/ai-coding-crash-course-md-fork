import { eq } from "drizzle-orm";
import { db } from "~/db";
import { DEFAULT_AT_RISK_THRESHOLD_DAYS, users } from "~/db/schema";

export { DEFAULT_AT_RISK_THRESHOLD_DAYS };

export const MIN_AT_RISK_THRESHOLD_DAYS = 3;
export const MAX_AT_RISK_THRESHOLD_DAYS = 90;

/** The user's saved at-risk threshold in days (14 when the user is unknown). */
export function getAtRiskThreshold(userId: number): number {
  const row = db
    .select({ days: users.atRiskThresholdDays })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.days ?? DEFAULT_AT_RISK_THRESHOLD_DAYS;
}

/** Saves the user's at-risk threshold; throws unless it is an integer in 3–90. */
export function setAtRiskThreshold(userId: number, days: number): void {
  if (
    !Number.isInteger(days) ||
    days < MIN_AT_RISK_THRESHOLD_DAYS ||
    days > MAX_AT_RISK_THRESHOLD_DAYS
  ) {
    throw new Error(
      `Threshold must be a whole number of days between ${MIN_AT_RISK_THRESHOLD_DAYS} and ${MAX_AT_RISK_THRESHOLD_DAYS}.`
    );
  }
  db.update(users).set({ atRiskThresholdDays: days }).where(eq(users.id, userId)).run();
}
