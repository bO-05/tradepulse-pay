import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { getErrorMessage } from "../lib/errors";
import { lockBodyScroll } from "../lib/useDialogFocus";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { formatCents } from "./format";

export interface ConfirmDetail {
  label: string;
  value: ReactNode;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Amount the action moves, in integer cents. */
  amountCents?: number;
  amountLabel?: string;
  /** Who receives the money or is affected, e.g. "Eastbay Electric (pay@eastbay.example)". */
  payee?: ReactNode;
  payeeLabel?: string;
  /** Plain-language consequence, e.g. "Captures funds and sends a PayPal payout; can't be undone". */
  effect: ReactNode;
  /** Extra rows such as gross, retainage withheld or funding source. */
  details?: ConfirmDetail[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  /** When set, the confirm button stays disabled until this checkbox is ticked. */
  acknowledgement?: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal confirmation for money-moving or irreversible actions. Focus starts on Cancel, Tab is trapped,
 * Escape cancels, and focus returns to the trigger on close. Confirm runs at most once at a time, so a
 * double click cannot fire the action twice; a thrown error is shown inside the dialog.
 */
export function ConfirmDialog({
  open,
  title,
  amountCents,
  amountLabel = "Amount",
  payee,
  payeeLabel = "Payee",
  effect,
  details,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  acknowledgement,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const titleId = useId();
  const effectId = useId();
  const ackId = useId();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAcknowledged(false);
    const restore = document.activeElement as HTMLElement | null;
    const release = lockBodyScroll();
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const node = dialogRef.current;
      if (!node) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!inFlight.current) onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !node.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !node.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      release();
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [open]);

  if (!open) return null;

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(getErrorMessage(err, "The action could not be completed."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const rows: ConfirmDetail[] = [];
  if (amountCents !== undefined) rows.push({ label: amountLabel, value: <span className="tabular-nums">{formatCents(amountCents)}</span> });
  if (payee !== undefined) rows.push({ label: payeeLabel, value: payee });
  if (details) rows.push(...details);

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-dialog flex items-end justify-center bg-black/75 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !inFlight.current) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={effectId}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-line bg-surface-overlay p-5 shadow-2xl outline-none"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden="true" className={tone === "danger" ? "mt-0.5 h-5 w-5 shrink-0 text-rose-300" : "mt-0.5 h-5 w-5 shrink-0 text-amber-300"} />
          <h2 id={titleId} className="flex-1 text-base font-semibold text-ink">
            {title}
          </h2>
          <IconButton label="Close" size="sm" icon={<X className="h-4 w-4" />} onClick={onCancel} disabled={busy} className="-mr-2 -mt-2" />
        </div>

        {rows.length > 0 && (
          <dl className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
                <dt className="text-ink-subtle">{row.label}</dt>
                <dd className="min-w-0 break-words text-right font-medium text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <p id={effectId} className="mt-4 text-sm leading-relaxed text-ink-muted">
          {effect}
        </p>

        {acknowledgement && (
          <div className="mt-4 flex items-start gap-2">
            <input
              id={ackId}
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-green-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            />
            <label htmlFor={ackId} className="text-sm text-ink">
              {acknowledgement}
            </label>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => void confirm()}
            loading={busy}
            disabled={Boolean(acknowledgement) && !acknowledged}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
