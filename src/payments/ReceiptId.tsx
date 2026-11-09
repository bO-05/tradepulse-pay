import { useState } from "react";

/** Business receipt identifiers, not bearer links, credentials or provider access tokens. */
export function ReceiptId({ label, value }: { label: string; value: string | null | undefined }) {
  const [notice, setNotice] = useState("");
  if (!value) return null;
  return (
    <div className="receipt-id flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-300">
      <span>{label}</span>
      <code className="min-w-0 [overflow-wrap:anywhere]">{value}</code>
      <button
        type="button"
        aria-label={`Copy ${label} ${value}`}
        className="inline-flex min-h-6 items-center rounded border border-slate-600 px-2 py-1 text-slate-200 hover:bg-slate-800"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setNotice("Copied");
          } catch {
            setNotice("Select and copy the ID shown.");
          }
        }}
      >Copy</button>
      {notice && <span role="status">{notice}</span>}
    </div>
  );
}
