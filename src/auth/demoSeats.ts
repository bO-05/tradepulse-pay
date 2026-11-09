import { payAppHash } from "./navigation";

/**
 * Where each public demo seat lands (architecture §8). The GC and Owner seats keep the shared
 * accounts and routes they always had; the Subcontractor seat is the Ortiz Plumbing residential
 * account, added for the Lopez reference job. Rosendin (`sub1@demo.tradepulse`) is unchanged and
 * stays reachable from inside the GC view, but it is never a seat on `#/demo`.
 */
export type DemoSeat = {
  /** Suffix of the pinned `demo-enter-<id>` test id. */
  testId: "gc" | "sub" | "owner";
  email: string;
  title: string;
  detail: string;
  hash: string;
};

/**
 * The settled Ortiz Plumbing pay app on the frozen Lopez Kitchen Remodel.
 *
 * The one-time sandbox settlement created this row and recorded it in
 * `docs/evidence/settlement/settlement-report.json`. Resolving the seat landing through this
 * constant keeps `#/demo` from scraping a screen or guessing an id; if the reference is ever
 * settled again, update this one value.
 */
export const SETTLED_LOPEZ_PAY_APP_ID = "ph7434a59sqck3nysgt6teqh0h8hvx1h";

export const DEMO_SEATS: readonly DemoSeat[] = [
  {
    testId: "gc",
    email: "gc@demo.tradepulse",
    title: "Sign in as the general contractor",
    detail: "Review a sub's pay app and release sandbox payment.",
    hash: "#/inbox",
  },
  {
    testId: "sub",
    email: "sub4@demo.tradepulse",
    title: "Subcontractor",
    detail: "Sign in as Ortiz Plumbing on the settled Lopez Kitchen Remodel pay app.",
    hash: payAppHash(SETTLED_LOPEZ_PAY_APP_ID),
  },
  {
    testId: "owner",
    email: "owner@demo.tradepulse",
    title: "Project owner",
    detail: "See job progress and pay a change-order invoice.",
    hash: "#/projects",
  },
];
