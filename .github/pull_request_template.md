## What changed

<!-- What the change does and the user-visible effect. Link the issue, remediation item or pay-app case it closes. -->

## Testing done

<!-- Commands you ran and what they proved. Keep the two required lines; add the guard audit when a public Convex function changed. Redact emails, tokens and account ids from pasted output. -->

- [ ] `npm run build` (tsc + Vite)
- [ ] `npx vitest run --maxWorkers=2`
- [ ] `npm run verify:guards` (public Convex surface or tenancy scope changed)
- [ ] `npm run verify:docs` (docs or screenshots changed)

## Risk and rollback

<!-- Money paths (authorize, capture, payout, retainage), webhooks and auth: name the failure mode and how to revert. Write "none" when the change cannot move money or change access. -->
