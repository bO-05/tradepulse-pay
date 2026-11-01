import { useMutation } from "convex/react";
import { FormEvent, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { getErrorMessage } from "../../lib/errors";
import { Button, DateInput, TimeInput, useToast } from "../../ui";

export const BID_DUE_TIME_HINT = "Optional, in the project's local time. Leave blank for end of day.";

type DuePkg = {
  _id: string;
  csiDivision: string;
  tradeName: string;
  bidDeadline: string;
  bidDueTime?: string;
  dueLabel?: string;
};

/** Date part of a stored deadline; older rows may carry a time after the date. */
function datePart(bidDeadline: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(bidDeadline)?.[0] ?? "";
}

function timePart(pkg: DuePkg): string {
  return pkg.bidDueTime ?? /T(\d{2}:\d{2})/.exec(pkg.bidDeadline)?.[1] ?? "";
}

/** "Bids due …" with an inline editor for the bid due date and optional time. */
export function BidDueEditor({ pkg, readOnly, compact, hideLabel }: { pkg: DuePkg; readOnly?: boolean; compact?: boolean; hideLabel?: boolean }) {
  const update = useMutation(api.tradePackages.updateBidDue);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(datePart(pkg.bidDeadline));
  const [time, setTime] = useState(timePart(pkg));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = () => {
    setDate(datePart(pkg.bidDeadline));
    setTime(timePart(pkg));
    setError(null);
    setEditing(true);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (saving) return;
    if (!date) {
      setError("Choose the bid due date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await update({ tradePackageId: pkg._id as Id<"tradePackages">, bidDeadline: date, bidDueTime: time });
      toast.success(`Bids for ${pkg.csiDivision} ${pkg.tradeName} are now due ${result.dueLabel}.`);
      setEditing(false);
    } catch (err) {
      setError(getErrorMessage(err, "We couldn't change the bid due date. Try again."));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <span className={`flex flex-wrap items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-ink-subtle`} onClick={(e) => e.stopPropagation()}>
        {!hideLabel && <span data-testid="bid-due-label">Bids due {pkg.dueLabel ?? pkg.bidDeadline}</span>}
        {!readOnly && (
          <button type="button" className="text-emerald-300 underline-offset-2 hover:underline" onClick={open} aria-label={`Edit bid due date for ${pkg.csiDivision} ${pkg.tradeName}`}>
            Edit due date
          </button>
        )}
      </span>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      onClick={(e) => e.stopPropagation()}
      noValidate
      aria-label={`Bid due date for ${pkg.csiDivision} ${pkg.tradeName}`}
      className="mt-2 space-y-3 rounded-xl border border-line bg-surface p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <DateInput id={`due-date-${pkg._id}`} label="Bid due date" required value={date} onChange={setDate} />
        <TimeInput id={`due-time-${pkg._id}`} label="Due time" value={time} onChange={setTime} hint={BID_DUE_TIME_HINT} />
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={saving} loadingLabel="Saving…">
          Save due date
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
