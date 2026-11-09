/**
 * The visible state of a preserved reference job: readable forever, never writable. Every surface
 * that locks writes with `assertReferenceWritable` shows this one-line notice so the refusal is
 * explained before a judge clicks anything (VAL-RES-009).
 */
export function ReferenceNotice({ title = "Preserved demo run · read-only." }: { title?: string }) {
  return (
    <aside className="rounded-xl border border-sky-800 bg-sky-950/40 px-3 py-2 text-xs text-sky-100" data-testid="read-only-reference">
      <strong>{title}</strong>
    </aside>
  );
}
