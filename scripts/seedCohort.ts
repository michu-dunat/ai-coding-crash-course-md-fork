import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../app/db/schema";
import {
  LessonProgressStatus,
  TeamMemberRole,
  UserRole,
} from "../app/db/schema";

// A cohort of generated students with ~90 days of activity, so the instructor
// dashboard has realistic data locally. Driven by a fixed-seed PRNG: the same
// input always produces the same rows.

export type CohortCourse = {
  id: number;
  price: number;
  instructorId: number;
  lessonIds: number[];
  quizzes: {
    id: number;
    passingScore: number;
    options: { questionId: number; optionId: number; correct: boolean }[];
  }[];
};

type Db = BetterSQLite3Database<typeof schema>;

const STUDENT_COUNT = 40;
const DAY = 24 * 60 * 60 * 1000;

const FIRST_NAMES = [
  "Ava",
  "Noah",
  "Mia",
  "Lucas",
  "Isla",
  "Mateo",
  "Zara",
  "Hiro",
  "Priya",
  "Diego",
  "Freya",
  "Kofi",
  "Lena",
  "Omar",
  "Yuki",
  "Elena",
  "Ravi",
  "Nina",
  "Tomas",
  "Aisha",
];
const LAST_NAMES = [
  "Nakamura",
  "Garcia",
  "Okafor",
  "Schmidt",
  "Patel",
  "Kowalski",
  "Silva",
  "Haddad",
  "Larsen",
  "Moreau",
  "Kim",
  "Novak",
  "Ibrahim",
  "Rossi",
  "Jensen",
];
// Country plus a PPP multiplier applied to the list price.
const COUNTRIES: [string, number][] = [
  ["US", 1],
  ["GB", 1],
  ["DE", 1],
  ["PL", 0.6],
  ["IN", 0.4],
  ["BR", 0.5],
  ["NG", 0.4],
  ["JP", 0.9],
];
const QUESTIONS = [
  "Could you explain this part again? I got lost halfway through.",
  "Is there a reason to prefer this approach over the alternative?",
  "My code doesn't match the video output — what am I missing?",
  "Will the next lesson cover error handling for this?",
  "Does this still apply to the latest version?",
];

/** mulberry32 — tiny deterministic PRNG returning floats in [0, 1). */
export function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Archetype = "completed" | "active" | "atRisk";

export function seedCohort(
  db: Db,
  {
    courses,
    now,
    seed = 42,
  }: { courses: CohortCourse[]; now: Date; seed?: number }
) {
  const rng = createRng(seed);
  const int = (min: number, max: number) =>
    min + Math.floor(rng() * (max - min + 1));
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  // A timestamp `days` days before now, nudged back by a few hours.
  const at = (days: number) =>
    new Date(now.getTime() - days * DAY - int(0, 6) * 3600_000).toISOString();

  // ─── Students ───
  const studentIds: number[] = [];
  for (let i = 0; i < STUDENT_COUNT; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[(i * 7) % LAST_NAMES.length];
    const user = db
      .insert(schema.users)
      .values({
        name: `${first} ${last}`,
        email: `${first}.${last}.${i + 1}@cohort.dev`.toLowerCase(),
        role: UserRole.Student,
        avatarUrl: `https://api.dicebear.com/9.x/avataaars/svg?seed=cohort${i + 1}`,
        createdAt: at(int(60, 90)),
      })
      .returning()
      .get();
    studentIds.push(user.id);
  }

  // ─── Team purchase ───
  // The first cohort student buys 6 seats of the last course; 3 get redeemed.
  const teamCourse = courses[courses.length - 1];
  const teamBuyer = studentIds[0];
  const teamDays = 70;
  const team = db
    .insert(schema.teams)
    .values({ createdAt: at(teamDays) })
    .returning()
    .get();
  db.insert(schema.teamMembers)
    .values({
      teamId: team.id,
      userId: teamBuyer,
      role: TeamMemberRole.Admin,
      createdAt: at(teamDays),
    })
    .run();
  const teamPurchase = db
    .insert(schema.purchases)
    .values({
      userId: teamBuyer,
      courseId: teamCourse.id,
      amountPaid: teamCourse.price * 6,
      country: "SE",
      createdAt: at(teamDays),
    })
    .returning()
    .get();
  const redeemers = new Set(studentIds.slice(1, 4));
  const redeemerList = [...redeemers];
  for (let s = 0; s < 6; s++) {
    const redeemer = redeemerList[s];
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: teamCourse.id,
        code: `TEAM-COHORT-${String(s + 1).padStart(3, "0")}`,
        purchaseId: teamPurchase.id,
        redeemedByUserId: redeemer ?? null,
        redeemedAt: redeemer ? at(teamDays - 2 - s) : null,
        createdAt: at(teamDays),
      })
      .run();
  }

  // ─── Enrollments and activity ───
  const archetypes: Archetype[] = ["completed", "active", "active", "atRisk"];
  const questionLessons: {
    userId: number;
    lessonId: number;
    days: number;
    course: CohortCourse;
  }[] = [];

  for (let i = 0; i < studentIds.length; i++) {
    const userId = studentIds[i];
    if (userId === teamBuyer) continue;
    const enrolledIn = courses.filter(
      (c, ci) =>
        (redeemers.has(userId) && c === teamCourse) ||
        (!redeemers.has(userId) && (ci === i % courses.length || rng() < 0.3))
    );

    for (const course of enrolledIn) {
      const archetype = pick(archetypes);
      const lessons = course.lessonIds;
      let enrollDays: number;
      let lastDays: number;
      let doneCount: number;
      if (archetype === "completed") {
        enrollDays = int(30, 90);
        lastDays = int(1, enrollDays - 10);
        doneCount = lessons.length;
      } else if (archetype === "active") {
        enrollDays = int(7, 80);
        lastDays = int(0, 5);
        doneCount = int(1, lessons.length - 1);
      } else {
        enrollDays = int(30, 90);
        lastDays = int(14, enrollDays - 5);
        doneCount = int(0, Math.max(1, Math.floor(lessons.length / 2)));
      }

      db.insert(schema.enrollments)
        .values({
          userId,
          courseId: course.id,
          enrolledAt: at(enrollDays),
          completedAt: archetype === "completed" ? at(lastDays) : null,
        })
        .run();

      if (!redeemers.has(userId)) {
        const [country, ppp] = pick(COUNTRIES);
        db.insert(schema.purchases)
          .values({
            userId,
            courseId: course.id,
            amountPaid: Math.round(course.price * ppp),
            country,
            createdAt: at(enrollDays),
          })
          .run();
      }

      // Lesson completions spread evenly from enrollment to last activity.
      const lessonDay = (li: number) =>
        Math.round(
          enrollDays -
            ((enrollDays - lastDays) * (li + 1)) / Math.max(doneCount, 1)
        );
      for (let li = 0; li < doneCount; li++) {
        db.insert(schema.lessonProgress)
          .values({
            userId,
            lessonId: lessons[li],
            status: LessonProgressStatus.Completed,
            completedAt: at(lessonDay(li)),
          })
          .run();
      }
      if (doneCount < lessons.length && archetype !== "atRisk") {
        db.insert(schema.lessonProgress)
          .values({
            userId,
            lessonId: lessons[doneCount],
            status: LessonProgressStatus.InProgress,
            completedAt: null,
          })
          .run();
      }

      // Video watch events on the first few lessons reached.
      const watched = Math.min(doneCount + 1, lessons.length, 4);
      for (let li = 0; li < watched; li++) {
        const days = Math.max(lessonDay(Math.min(li, doneCount - 1)), lastDays);
        const length = 300 + ((lessons[li] * 97) % 600);
        const finished = li < doneCount && rng() < 0.7;
        const furthest = finished
          ? length
          : Math.round(length * (0.1 + rng() * 0.8));
        const event = (eventType: string, positionSeconds: number) =>
          db
            .insert(schema.videoWatchEvents)
            .values({
              userId,
              lessonId: lessons[li],
              eventType,
              positionSeconds,
              createdAt: at(days),
            })
            .run();
        event("play", 0);
        const mid = Math.round(furthest * 0.4);
        event("pause", mid);
        if (rng() < 0.5) event("seek", Math.round(furthest * 0.6));
        event("play", mid);
        event(finished ? "ended" : "pause", furthest);
      }

      // Quiz attempts for every quiz on a completed lesson. The first question
      // of each quiz is the hard one.
      for (const quiz of course.quizzes) {
        const questionIds = [...new Set(quiz.options.map((o) => o.questionId))];
        const attempts =
          doneCount === 0 ? 0 : archetype === "atRisk" ? 1 : int(1, 2);
        for (let a = 0; a < attempts; a++) {
          const picks = questionIds.map((qId, qi) => {
            const wrongChance = (qi === 0 ? 0.6 : 0.15) / (a + 1);
            const opts = quiz.options.filter((o) => o.questionId === qId);
            const wrong = rng() < wrongChance;
            return opts.find((o) => o.correct === !wrong) ?? opts[0];
          });
          const score = picks.filter((p) => p.correct).length / picks.length;
          const attempt = db
            .insert(schema.quizAttempts)
            .values({
              userId,
              quizId: quiz.id,
              score,
              passed: score >= quiz.passingScore,
              attemptedAt: at(Math.max(lastDays, enrollDays - 3 - a)),
            })
            .returning()
            .get();
          for (const p of picks) {
            db.insert(schema.quizAnswers)
              .values({
                attemptId: attempt.id,
                questionId: p.questionId,
                selectedOptionId: p.optionId,
              })
              .run();
          }
        }
      }

      // Ratings from finishers and some active students.
      if (
        archetype === "completed" ||
        (archetype === "active" && rng() < 0.4)
      ) {
        const rating = archetype === "completed" ? int(4, 5) : int(2, 5);
        const ratedAt = at(lastDays);
        db.insert(schema.courseRatings)
          .values({
            userId,
            courseId: course.id,
            rating,
            createdAt: ratedAt,
            updatedAt: ratedAt,
          })
          .run();
      }

      if (doneCount > 0 && rng() < 0.35) {
        questionLessons.push({
          userId,
          lessonId: lessons[doneCount - 1],
          days: lastDays,
          course,
        });
      }
    }
  }

  // ─── Comments ───
  // Questions from students; every other one gets an instructor reply.
  questionLessons.forEach((q, qi) => {
    const question = db
      .insert(schema.comments)
      .values({
        lessonId: q.lessonId,
        userId: q.userId,
        body: QUESTIONS[qi % QUESTIONS.length],
        createdAt: at(q.days),
      })
      .returning()
      .get();
    if (qi % 2 === 0) {
      db.insert(schema.comments)
        .values({
          lessonId: q.lessonId,
          userId: q.course.instructorId,
          parentId: question.id,
          body: "Good question — see the follow-up notes in the lesson description.",
          createdAt: at(Math.max(0, q.days - 1)),
        })
        .run();
    }
  });

  return { studentIds };
}
