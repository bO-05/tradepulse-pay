# Production environment names (earnest-mongoose-745)

Names-only reconciliation of every environment variable the backend reads against the production
Convex deployment `earnest-mongoose-745`. No values are recorded here or were printed while
building it.

How it was built (2026-10-08):

- Backend-read names: every `process.env.X` and `env.X` in `convex/` (tests and `_generated/`
  excluded), the names declared in `convex/convex.config.ts`, the `PAYPAL_SANDBOX_*_EMAIL` names
  read through `process.env[name]`, and the Convex deployment names in `.env.example`.
- Configured names: `npx convex env list | cut -d= -f1` on production (the production deploy key for
  `earnest-mongoose-745` was confirmed first) and on dev `exuberant-boar-323` for comparison.

Categories:

- **set on prod**: configured on production (and on dev).
- **system-provided**: Convex provides it on every deployment; never set by hand (`CONVEX_CLOUD_URL`
  is also provided but no backend code reads it).
- **optional**: unset on both dev and production; the code works without it. Each one is marked
  `# optional` with a reason in `.env.example`.

No required name was missing on production, so nothing was set, redeployed or reseeded.

| Name | Category | Dev |
|---|---|---|
| `AGENTMAIL_API_KEY` | set on prod | set |
| `AGENTMAIL_BASE_URL` | optional | unset |
| `AGENTMAIL_WEBHOOK_SECRET` | optional | set (Oct 8, dev AgentMail webhook) |
| `EMAIL_DAILY_BUDGET` | optional | set (60; prod default 30) |
| `ANTHROPIC_API_KEY` | set on prod | set |
| `ANTHROPIC_MODEL` | set on prod | set |
| `AUTH_AGENTID_ID` | set on prod | set |
| `AUTH_AGENTID_SECRET` | set on prod | set |
| `CONVEX_SITE_URL` | system-provided | system-provided |
| `FIRECRAWL_API_KEY` | set on prod | set |
| `FIRECRAWL_API_URL` | optional | unset |
| `FIRECRAWL_WEBHOOK_SECRET` | optional | unset |
| `GCLOUD_ACCESS_TOKEN` | optional | unset |
| `GCP_PROJECT` | optional | unset |
| `GEMINI_API_KEY` | optional | unset |
| `GEMINI_MODEL` | optional | unset |
| `GOOGLE_ACCESS_TOKEN` | optional | unset |
| `GOOGLE_CLOUD_PROJECT` | optional | unset |
| `GOOGLE_CLOUD_REGION` | optional | unset |
| `JWKS` | set on prod | set |
| `JWT_PRIVATE_KEY` | set on prod | set |
| `KERNEL_API_KEY` | set on prod | set |
| `OPENAI_API_KEY` | optional | unset |
| `OPENAI_MODEL` | optional | unset |
| `PAYPAL_CLIENT_ID` | set on prod | set |
| `PAYPAL_CLIENT_SECRET` | set on prod | set |
| `PAYPAL_ENV` | set on prod | set |
| `PAYPAL_SANDBOX_GC_BUYER_EMAIL` | set on prod | set |
| `PAYPAL_SANDBOX_OWNER_EMAIL` | set on prod | set |
| `PAYPAL_SANDBOX_SUB1_EMAIL` | set on prod | set |
| `PAYPAL_SANDBOX_SUB2_EMAIL` | set on prod | set |
| `PAYPAL_SANDBOX_SUB3_EMAIL` | set on prod | set |
| `PAYPAL_WEBHOOK_ID` | set on prod | set |
| `SITE_URL` | set on prod | set |
| `VERTEX_ACCESS_TOKEN` | optional | unset |
| `VERTEX_API_KEY` | optional | unset |
| `VERTEX_LOCATION` | optional | unset |
| `VERTEX_MODEL` | optional | unset |
| `VERTEX_PROJECT_ID` | optional | unset |
