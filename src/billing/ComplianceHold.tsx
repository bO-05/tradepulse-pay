import { useMutation } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Button, ConfirmDialog, Field, StatusPill, formatDate } from "../ui";
import { inputClass } from "../ui/Field";

type Panel = NonNullable<FunctionReturnType<typeof api.billing.canPay.paymentPanel>>;
type Compliance = Panel["compliance"];

export const OVERRIDE_REASON_MAX = 500;
export const ADMIN_ONLY_TEXT = "Only company admins can override";

export function overrideText(o: NonNullable<Compliance["override"]>): string {
  return `Compliance override by ${o.byName} on ${formatDate(o.at)}: ${o.reason}`;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm text-amber-200" data-testid="compliance-warnings">
      {warnings.map((w) => (
        <li key={w}>Compliance warning: {w}</li>
      ))}
    </ul>
  );
}

/** GC side of the compliance hold: the override on record, expiry warnings and the admin-only override. */
export function GcComplianceHold({ compliance, payAppId, subcontractorName }: { compliance: Compliance; payAppId: string; subcontractorName: string }) {
  const override = useMutation(api.compliance.override.overrideComplianceHold);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const hintId = useId();
  const showControl = compliance.onHold;
  if (!showControl && compliance.override === null && compliance.warnings.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="compliance-hold">
      {compliance.override ? (
        <p className="text-sm text-ink" data-testid="compliance-override">
          {overrideText(compliance.override)}
        </p>
      ) : null}
      <Warnings warnings={compliance.warnings} />
      {showControl ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!compliance.canOverride}
            aria-describedby={compliance.isAdmin ? undefined : hintId}
            onClick={() => {
              setReason("");
              setReasonError(null);
              setOpen(true);
            }}
            data-testid="compliance-override-button"
          >
            Override compliance hold
          </Button>
          {!compliance.isAdmin ? (
            <span id={hintId} className="text-xs text-ink-subtle" data-testid="compliance-override-admin-only">
              {ADMIN_ONLY_TEXT}
            </span>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={open}
        title="Override the compliance hold?"
        effect={`Lets this pay app be paid to ${subcontractorName} despite the hold. It applies to this pay app only; other pay apps stay on hold and every other payment check still applies. Your name, the time and the reason are recorded in the audit log.`}
        details={compliance.holdMessage ? [{ label: "Hold", value: compliance.holdMessage }] : []}
        confirmLabel="Override hold"
        tone="danger"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          const trimmed = reason.trim();
          if (trimmed === "") {
            setReasonError("Enter a reason for the override.");
            return;
          }
          await override({ payAppId, reason: trimmed });
          setOpen(false);
        }}
      >
        <Field label="Reason" required error={reasonError ?? undefined}>
          {(control) => (
            <textarea
              {...control}
              rows={3}
              maxLength={OVERRIDE_REASON_MAX}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(null);
              }}
              className={inputClass(Boolean(reasonError), "py-2")}
              data-testid="compliance-override-reason"
            />
          )}
        </Field>
      </ConfirmDialog>
    </div>
  );
}

/** Sub side: only that the payment is on hold for compliance, and what is about to expire. */
export function SubComplianceHold({ compliance }: { compliance: Compliance }) {
  if (!compliance.onHold && compliance.warnings.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="compliance-hold">
      {compliance.onHold ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status="compliance_hold" label="On hold: compliance" tone="danger" />
          {compliance.holdMessage ? <span className="text-sm text-amber-200">{compliance.holdMessage}</span> : null}
        </div>
      ) : null}
      <Warnings warnings={compliance.warnings} />
    </div>
  );
}
