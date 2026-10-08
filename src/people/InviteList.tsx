import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { effectiveInviteStatus, INVITE_KIND_LABEL, inviteStatusLabel, type InviteEmailStatus, type InviteKind, type InviteStatus } from "../../convex/lib/inviteRules";
import { Button, ConfirmDialog, DateText, StatusPill, useToast } from "../ui";
import type { StatusTone } from "../ui";
import { InviteDialog, type InviteDialogMode } from "./InviteDialog";

export type InviteRow = {
  _id: string;
  email: string;
  kind?: InviteKind;
  status: InviteStatus;
  emailStatus: InviteEmailStatus;
  emailError: string | null;
  expiresAt: number;
  createdAt: number;
  lastSentAt: number | null;
  companyName?: string | null;
};

function tone(label: string): StatusTone {
  if (label === "Accepted") return "success";
  if (label === "Revoked" || label === "Expired") return "muted";
  if (label.includes("failed") || label.includes("bounced") || label.includes("daily limit")) return "warning";
  return "info";
}

/** Clock for client-side expiry (queries never read the clock); ticks once a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Invites with plain-words status and Copy link / Resend / Revoke for pending ones. */
export function InviteList({ invites, showKind = true, emptyText }: { invites: InviteRow[]; showKind?: boolean; emptyText: string }) {
  const revoke = useMutation(api.invites.revoke);
  const toast = useToast();
  const now = useNow();
  const [dialog, setDialog] = useState<InviteDialogMode | null>(null);
  const [revoking, setRevoking] = useState<InviteRow | null>(null);

  if (invites.length === 0) return <p className="text-sm text-ink-subtle">{emptyText}</p>;

  return (
    <>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Invites">
        {invites.map((i) => {
          const label = inviteStatusLabel(i, now);
          const pending = effectiveInviteStatus(i, now) === "pending";
          return (
            <li key={i._id} className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid="invite-row">
              <div className="min-w-0">
                <p className="font-medium break-all">{i.email}</p>
                <p className="text-xs text-ink-subtle">
                  {showKind && i.kind ? `${INVITE_KIND_LABEL[i.kind]}${i.companyName ? ` · ${i.companyName}` : ""} · ` : ""}
                  {i.lastSentAt ? (
                    <>
                      Emailed <DateText value={i.lastSentAt} />
                    </>
                  ) : (
                    <>
                      Created <DateText value={i.createdAt} />
                    </>
                  )}
                  {pending ? (
                    <>
                      {" "}
                      · Expires <DateText value={i.expiresAt} />
                    </>
                  ) : null}
                </p>
                {(i.emailStatus === "failed" || i.emailStatus === "bounced") && i.emailError && pending ? (
                  <p className="text-xs text-amber-200">
                    Email {i.emailStatus === "bounced" ? "bounced" : "failed"} — copy the link or resend ({i.emailError})
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={null} label={label} tone={tone(label)} />
                {pending && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ type: "resend", inviteId: i._id, email: i.email, sendEmail: false })}>
                      Copy link
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ type: "resend", inviteId: i._id, email: i.email, sendEmail: true })}>
                      Resend
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(i)}>
                      Revoke
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {dialog && <InviteDialog key={JSON.stringify(dialog)} mode={dialog} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke the invite for ${revoking?.email ?? ""}?`}
        effect="The invite link stops working right away. You can send a new invite later."
        confirmLabel="Revoke invite"
        tone="danger"
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await revoke({ inviteId: revoking._id });
          toast.success(`Invite for ${revoking.email} revoked.`);
          setRevoking(null);
        }}
      />
    </>
  );
}
