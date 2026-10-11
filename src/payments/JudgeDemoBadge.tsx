/** Discloses that the one-click guided demo filed this pay app as a stand-in, not the sub or agent in person. */
export function JudgeDemoBadge({ filedBy }: { filedBy: string | null }) {
  if (!filedBy) return null;
  return (
    <span
      className="inline-block rounded-full border border-amber-700 bg-amber-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200"
      data-testid="judge-demo-badge"
      title={`Filed by the Demo company's guided demo, run by ${filedBy}, as a stand-in for the submitter shown.`}
    >
      Guided demo (Demo) · filed by {filedBy}
    </span>
  );
}
