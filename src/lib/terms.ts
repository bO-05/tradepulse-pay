/**
 * Client access to the shared vocabulary layer. The values live in `convex/lib/terms.ts` so the
 * server can generate residential labels from the same source; this module is the import point
 * the UI contract names (`src/lib/terms.ts`).
 */
export { termsForKind } from "../../convex/lib/terms";
export type { DrawColumns, ProjectKind, Terms } from "../../convex/lib/terms";
