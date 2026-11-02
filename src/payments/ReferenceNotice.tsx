export function ReferenceNotice() {
  return (
    <aside className="rounded-xl border border-sky-800 bg-sky-950/40 p-3 text-sm text-sky-100" data-testid="read-only-reference">
      <strong>Preserved reference · read-only.</strong> Financial and workflow changes are locked on the server.
      Inspect the settled receipts here, or <a href="#/judge-demo" className="underline">start a fresh guided run</a> to try sandbox actions.
    </aside>
  );
}
