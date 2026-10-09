import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Leveling plugs (§15): a GC-entered amount on a bid exclusion so bids compare on the same scope.
 * Comparison only: plugs never enter the contract sum, the SOV or anything billable.
 */

export type BidExclusion = Doc<"bids">["identifiedExclusions"][number];
export type PlugActor = { userId?: Id<"users">; name: string };

export const PLUG_NOTE_MAX = 200;

export function cleanPlugNote(note: string | undefined): string | undefined {
  const trimmed = (note ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length > PLUG_NOTE_MAX) {
    throw new ConvexError({ code: "INVALID", field: "note", message: `Keep the plug note under ${PLUG_NOTE_MAX} characters.` });
  }
  return trimmed || undefined;
}

function plugOf(e: { costImpactCents?: number }): number {
  return typeof e.costImpactCents === "number" && Number.isSafeInteger(e.costImpactCents) ? e.costImpactCents : 0;
}

function withoutAttribution(e: BidExclusion): BidExclusion {
  const { plugNote: _n, plugEnteredByUserId: _u, plugEnteredByName: _b, plugEnteredAt: _a, ...rest } = e;
  return rest;
}

function previousFor(previous: readonly BidExclusion[], next: BidExclusion, index: number): BidExclusion | undefined {
  const same = previous[index];
  if (same && same.description.trim() === next.description.trim()) return same;
  return previous.find((p) => p.description.trim() === next.description.trim());
}

/**
 * Server-side plug attribution for a GC leveling write. A plug whose amount or note changed is
 * attributed to the acting GC member now; an unchanged one keeps its stored attribution; a $0 plug
 * carries none. Attribution sent by the client is never trusted.
 */
export function attributePlugs(
  previous: readonly BidExclusion[],
  next: readonly BidExclusion[],
  actor: PlugActor,
  now: number,
): BidExclusion[] {
  return next.map((raw, index) => {
    const e = withoutAttribution(raw);
    const amount = plugOf(e);
    // Negative amounts pass through unchanged so the caller's validation rejects them.
    if (amount <= 0) return e;
    const note = cleanPlugNote(raw.plugNote);
    const prev = previousFor(previous, raw, index);
    if (prev && plugOf(prev) === amount && (prev.plugNote ?? undefined) === note && prev.plugEnteredAt !== undefined) {
      return {
        ...e,
        ...(note ? { plugNote: note } : {}),
        ...(prev.plugEnteredByUserId ? { plugEnteredByUserId: prev.plugEnteredByUserId } : {}),
        ...(prev.plugEnteredByName ? { plugEnteredByName: prev.plugEnteredByName } : {}),
        plugEnteredAt: prev.plugEnteredAt,
      };
    }
    return {
      ...e,
      ...(note ? { plugNote: note } : {}),
      ...(actor.userId ? { plugEnteredByUserId: actor.userId } : {}),
      plugEnteredByName: actor.name,
      plugEnteredAt: now,
    };
  });
}

const PRICING_REASONING = /\b(cost ?impact|benchmark|unpriced|no dollar amount|plug|RSMeans|ASPE|leveled total|carry the)\b/i;

/**
 * The scope text of a parser-written exclusion, without the parser's pricing reasoning ("No dollar
 * amount is stated … so costImpact is 0"), which would contradict a plug the GC enters later.
 */
export function exclusionScopeText(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length <= 1) return text;
  const [first, ...rest] = sentences;
  return [first, ...rest.filter((s) => !PRICING_REASONING.test(s))].join(" ");
}

/** Plug fields to carry when an exclusion is kept across a bid revision. */
export function keptPlugFields(e: BidExclusion) {
  return {
    costImpactCents: e.costImpactCents ?? 0,
    ...(e.plugNote ? { plugNote: e.plugNote } : {}),
    ...(e.plugEnteredByUserId ? { plugEnteredByUserId: e.plugEnteredByUserId } : {}),
    ...(e.plugEnteredByName ? { plugEnteredByName: e.plugEnteredByName } : {}),
    ...(e.plugEnteredAt !== undefined ? { plugEnteredAt: e.plugEnteredAt } : {}),
  };
}
