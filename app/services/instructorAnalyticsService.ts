// Instructor analytics, one module per dashboard tab. The at-risk threshold
// setting lives in ~/services/atRiskThresholdService.
export { getScopedCourseIds, type AnalyticsScope } from "~/services/instructorAnalytics/scope";
export * from "~/services/instructorAnalytics/overview";
export * from "~/services/instructorAnalytics/students";
export * from "~/services/instructorAnalytics/content";
export * from "~/services/instructorAnalytics/revenue";
