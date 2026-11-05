import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, ConfirmDialog, TextInput, formatDateTime, useToast } from "../ui";

/**
 * GC-only opt-in switch on the agreement. Off by default: enabling it makes every payout wait for
 * the sub's signed conditional waiver (and, where a prior payment exists, its unconditional waiver).
 */
export function LienWaiverGateCard({ agreementId }: { agreementId: string }) {
  const data = useQuery(api.lienWaivers.agreementGate, { agreementId });
  const setGate = useMutation(api.lienWaivers.setGate);
  const toast = useToast();
  const [confirm, setConfirm] = useState<"enable" | "disable" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (data === undefined || data === null) return null;
  if (!data.canManage && !data.enabled) return null;

  const change = async (enabled: boolean, why?: string) => {
    setError(null);
    try {
      await setGate({
        agreementId,
        enabled,
        requirePriorUnconditional: true,
        ...(enabled || !why?.trim() ? {} : { reason: why.trim() }),
      });
      toast.success(enabled ? "Lien-waiver gate enabled." : "Lien-waiver gate turned off.");
      setConfirm(null);
      setReason("");
    } catch (err) {
      setError(getErrorMessage(err, "The lien-waiver setting could not be changed."));
    }
  };

  return (
    <Card
      title="Lien-waiver gate"
      headingLevel={3}
      description="Optional. When on, a payout waits for the sub's signed waiver instead of relying on a checkbox."
      data-testid="lien-waiver-gate-card"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-full border border-line bg-surface-raised p-2 text-emerald-300" aria-hidden="true">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          {data.enabled ? (
            <>
              <p className="font-semibold text-ink">Gate is on</p>
              <p className="text-ink-muted">
                The sub signs a conditional waiver for the approved payment. When an earlier payment was approved after the gate
                was enabled, the sub also signs an unconditional waiver for that payment. The pay gate names any missing
                signature before money moves.
              </p>
              <p className="text-xs text-ink-subtle">
                Enabled {data.enabledAt !== null ? formatDateTime(data.enabledAt) : "earlier"}
                {data.enabledByName ? ` by ${data.enabledByName}` : ""}.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-ink">Gate is off</p>
              <p className="text-ink-muted">
                Payouts do not require a waiver signature. Turn the gate on when this subcontract should collect a conditional
                waiver for each payment and an unconditional waiver for the prior one.
              </p>
            </>
          )}
          <p className="text-xs text-ink-subtle">{data.disclaimer}</p>
          {data.canManage ? (
            <Button
              variant={data.enabled ? "secondary" : "primary"}
              size="sm"
              onClick={() => {
                setError(null);
                setConfirm(data.enabled ? "disable" : "enable");
              }}
              data-testid="lien-waiver-gate-toggle"
            >
              {data.enabled ? "Turn off gate" : "Enable lien-waiver gate"}
            </Button>
          ) : (
            <p className="text-xs text-ink-subtle">Only a company admin can change this setting.</p>
          )}
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirm === "enable"}
        title="Enable the lien-waiver gate?"
        effect="Every payout on this subcontract will wait for the sub's signed conditional waiver. If an earlier payment was approved after this switch is enabled, its unconditional waiver is required too. You can turn the gate off again; signatures already recorded stay in the audit trail."
        confirmLabel="Enable gate"
        onCancel={() => setConfirm(null)}
        onConfirm={() => change(true)}
      />
      <ConfirmDialog
        open={confirm === "disable"}
        title="Turn off the lien-waiver gate?"
        tone="danger"
        effect="Payouts stop waiting for a waiver signature. Signatures already recorded are kept, and the change is written to the audit log."
        confirmLabel="Turn off gate"
        onCancel={() => setConfirm(null)}
        onConfirm={() => change(false, reason)}
      >
        <TextInput
          label="Reason shown to the sub (optional)"
          value={reason}
          maxLength={500}
          onChange={setReason}
        />
      </ConfirmDialog>
    </Card>
  );
}
