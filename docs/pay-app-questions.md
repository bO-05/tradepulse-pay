# Pay-app questions

The question thread gives the subcontractor and general contractor a plain-language place to discuss
one pay application. The sub can **Question this amount**; the GC can reply. The thread never changes
the G702/G703, the approval, the ledger or a payment.

## What each side sees

On any submitted, approved, paid, rejected or revision-requested pay app, both companies see
**Questions about this amount**:

- The sub sees its own entries and the GC's replies, plus **Question this amount** while the app is
  open.
- The GC sees the same entries, plus **Reply to the sub**.
- Each entry names the company role (`SUB` or `GC`), the author and the server time.
- The card says that the thread does not change the pay app, approval or payment.

A draft pay app is visible only to the filing sub. The GC gets no thread for a draft, matching the
pay-app read rule. A withdrawn pay app's existing thread stays readable to both companies, but new
entries are closed.

## Who can post

Posting requires an active, verified human member of the GC or subcontractor company on that
project. The server derives the project and agreement from the pay app; the client cannot choose a
different project or company.

- **Owners, other GCs and other subcontractors:** `Not found.` They never see the thread.
- **Billing agents:** they can read the thread but cannot post. The card explains that a human must
  sign in to ask or reply.
- **Archived projects and preserved read-only demo runs:** the thread is read-only. The card names
  the reason instead of showing a composer.
- **Draft or withdrawn:** posting is refused with `PAY_APP_NOT_OPEN`.

## Server behaviour

`convex/payApps/questions.ts` exposes:

- `list({ payAppId })` – the thread, counterparty, current status and whether this viewer can post.
- `post({ payAppId, body })` – trims the body, requires 2 to 2,000 characters, stores one entry,
  writes an audit event and notifies the other company in-app.

`payAppThreadEntries` stores `projectId`, `agreementId`, `payAppId`, `authorUserId`, `authorRole`,
`authorName`, `body` and `createdAt`, indexed by pay app and creation time. A post notifies every
active human member of the other company with a link to `#/pay-apps/<id>`; notifications remain
in-app only. The audit event is `pay_app_question` for the sub and `pay_app_reply` for the GC.

The mutation is deliberately not a financial write. It does not update the pay application, its
lines, the approval decision, proposals, ledger or PayPal state.

## Tests

`convex/payApps/questions.test.ts` covers:

1. The sub asks and the GC replies; both sides see both entries, the other company gets one in-app
   notification per recipient, and the audit events are recorded.
2. The thread leaves the pay application document byte-for-byte unchanged.
3. A draft is hidden from the GC, visible to the filing sub, and refuses a question.
4. The Owner, another GC and signed-out callers cannot read or post.
5. A preserved read-only project exposes the thread but refuses new entries.
6. A linked billing agent can read but cannot post.
7. Empty and oversized bodies are refused, and a valid body is trimmed.

Browser acceptance: `scripts/qa/pay-app-thread-browser.mjs` passed **21/21 checks** against canonical
build `0ba5d11` on 2026-11-05. It sent a sub question on the R6-A dev pay app, read it as the GC,
replied as the GC, read the reply as the sub, confirmed the money trail stayed the same, and opened
the preserved reference pay app to confirm the thread was read-only with no composer.

Evidence: `evidence/pay-app-thread-browser-2026-11-05T08-14-04-182Z/report.json`. The run wrote two
synthetic thread entries to the R6-A dev run; it made no financial write, PayPal call or guided run,
and it did not mutate the preserved reference.

## Limits

- Plain text only; no attachments, editing, deleting, resolution status or read receipts.
- One flat thread per pay app; no separate topics or notifications for individual entries beyond the
  opposite company alert.
- The read query returns at most the first 200 entries.
- This is a conversation, not a formal notice of dispute, lien notice or contract amendment.
- The thread is not emailed; notifications are in-app only.
