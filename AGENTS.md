# Cadence

A course platform (a mini Udemy), used as the exercise repo for the AI Coding Crash Course. `request-logger/` is a standalone proxy that logs a coding agent's model requests — unrelated to the app.

## Gotchas

- Run `npm run typecheck`, not bare `tsc` — it runs `react-router typegen` first, and `tsc` alone reports the `./+types/*` route modules missing.
- Keep `app/db/index.ts` side-effect free, so `better-sqlite3` stays out of the client bundle.
- Routes call services; only services touch `db`.
- Loaders and actions are authorised independently — every mutating action calls a `require*` guard from `app/lib/access.server.ts` itself.
- Render student-authored text with `renderComment` (`app/lib/comment-markdown.server.ts`); `renderMarkdown` is for trusted instructor content only.
- There is no password auth. A 401 reading "Select a user from the DevUI panel" means the session has no user — switch user via the DevUI panel (`app/components/dev-ui.tsx`).
- `data.db` is disposable — delete it and run `npm run db:seed` when it gets into a bad state.

## Course Repo Workflow

`main` is the student starting point; lesson checkpoints are commits on the `live-run-through` branch, each prefixed with a slug that the `reset` / `cherry-pick` scripts consume. Slugs are a public interface, also referenced in recorded video — keep existing slugs unchanged so student navigation keeps working.
