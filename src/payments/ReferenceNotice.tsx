/**
 * The visible state of a preserved reference job: readable forever, never writable. Every surface
 * that locks writes with `assertReferenceWritable` shows this notice so the refusal is explained
 * before a judge clicks anything (VAL-RES-009).
 */
export function ReferenceNotice({
  title = "Preserved demo run · read-only.",
  showFreshRunLink = true,
}: {
  title?: string;
  /** The sub seat cannot open the GC-only guided demo, so it only reads the notice. */
  showFreshRunLink?: boolean;
}) {
  return (
    <aside className="rounded-xl border border-sky-800 bg-sky-950/40 p-3 text-sm text-sky-100" data-testid="read-only-reference">
      <strong>{title}</strong> Financial and workflow changes are locked on the server.
      {showFreshRunLink ? (
        <>
          {" "}
          Inspect the settled receipts here, or{" "}
          <a href="#/judge-demo" className="inline-flex min-h-6 items-center underline">
            start a fresh guided run
          </a>{" "}
          to try sandbox actions.
        </>
      ) : (
        " Inspect the settled receipts here."
      )}
    </aside>
  );
}
