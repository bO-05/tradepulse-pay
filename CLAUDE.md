<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Agent guide

TradePulse Pay is a Vite + React front end with a Convex backend. Money paths use
integer cents, and every public Convex function is role-guarded.

### Commands

- Install: `npm ci` (Node.js 22 or newer).
- Dev: `npm run dev` serves the app on http://localhost:3150; Convex Auth sign-in only works on that exact origin.
- Type check: `npx tsc -b`.
- Test: `npx vitest run --maxWorkers=2` (the same runner as `npm test`). Tests use `convex-test` in memory and must pass without real API keys; `vitest.setup.ts` strips live env values.
- Build: `npm run build` runs the type check, then the Vite production build.
- Guards: `npm run verify:guards` audits every public Convex function for a role guard and, when it reads project data, a tenancy guard.
- Docs: `npm run verify:docs` checks every relative link under `docs/` and in README.md.
- This file: `npm run verify:agents` re-checks the commands and paths written here.

### Local environment

- A Convex deployment is required for sign-in and data. Put the browser values in `.env.local`, push functions with `npx convex dev --once`, then seed the demo accounts. README.md has the full sequence.
- Deployment secrets belong in the Convex environment, never in the repository. `.env.example` lists every variable name.

### Conventions

- Amounts are integer cents (`*Cents`) and convert to PayPal strings only through `convex/lib/money.ts`.
- Every public Convex query, mutation and action starts with a role guard, plus a tenancy guard when it touches project data.
- Never hand-edit files under `convex/_generated/`; they are generated and tracked in git.
- Tests live beside the code as `*.test.ts` under `convex/` or `src/` and run with Vitest.
