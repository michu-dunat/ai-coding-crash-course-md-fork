// Lesson feedback limits live here rather than in lessonFeedbackService so that
// client components can import them without pulling the database driver into
// the browser bundle.

export const MAX_FEEDBACK_LENGTH = 2000;
export const FEEDBACK_PAGE_SIZE = 20;
