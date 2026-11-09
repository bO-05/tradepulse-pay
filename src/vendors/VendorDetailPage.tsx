import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Button, Card, ConfirmDialog, DateText, PageHeader, StatusPill, useToast } from "../ui";
import { useActiveCompany } from "../auth/companyContext";
import { publicContactEmail } from "../lib/demoPrivacy";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

/** A GC's vendor: directory details, the linked sub company's own profile, and payee confirmation. */
export function VendorDetailPage({ vendorId }: { vendorId: string }) {
  const vendor = useQuery(api.partyProfiles.getVendor, { vendorId });
  const { isDemo } = useActiveCompany();
  const confirmPayee = useMutation(api.payee.confirmPayee);
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  if (vendor === undefined) return <p className="text-sm text-slate-400">Loading vendor…</p>;
  const { payee, linkedCompany } = vendor;
  const address = linkedCompany?.address;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={vendor.name}
        back={{ href: "#/vendors", label: "Vendors" }}
        meta={
          <>
            <StatusPill status={vendor.status} />
            {linkedCompany && <StatusPill status="linked" label="Linked · company account" />}
            {payee.status !== "none" && <StatusPill status={`payee_${payee.status}`} />}
          </>
        }
      />

      <Card title="Payee" description="Payouts go only to a payout PayPal email that someone at your company has confirmed.">
        {payee.status === "none" ? (
          <p className="text-sm text-ink-muted">
            {linkedCompany
              ? `${linkedCompany.name} has not set a payout PayPal email yet. Payouts to this vendor are blocked until it does and you confirm it.`
              : "This vendor has no TradePulse Pay company account yet. Invite it to a project; payouts are blocked until it sets a payout PayPal email and you confirm it."}
          </p>
        ) : (
          <dl>
            <Row label="Payout PayPal email">
              <span className="font-mono" data-testid="payee-current-email">
                {payee.currentEmail}
              </span>
            </Row>
            {payee.status === "confirmed" ? (
              <Row label="Confirmed">
                by {payee.confirmedByName ?? "a team member"} on <DateText value={payee.confirmedAt} withTime />
              </Row>
            ) : (
              <Row label="Status">
                <span className="text-amber-200">
                  Payee change pending. {vendor.name} set this email; payouts are blocked until you confirm it.
                </span>
              </Row>
            )}
          </dl>
        )}
        {payee.status === "pending" && (isDemo ? (
          <p className="mt-3 text-xs text-amber-200">Shared demo · read-only. Payee confirmation belongs to the vendor's own company and is disabled here.</p>
        ) : vendor.viewerIsAdmin ? (
          <div className="mt-3 space-y-2">
            <Button onClick={() => setConfirming(true)}>Confirm payee</Button>
            <p className="text-xs text-amber-200">
              Verify the new email out of band, by phone or a known contact, before confirming.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-amber-200" data-testid="payee-admin-only">
            Only a company admin can confirm this payout address. Ask a company admin to verify the new email out of band and confirm it.
          </p>
        ))}
      </Card>

      <Card title="Company profile" description={linkedCompany ? `Maintained by ${linkedCompany.name}. Only its admins can change it.` : undefined}>
        {linkedCompany ? (
          <dl>
            <Row label="Company">{linkedCompany.name}</Row>
            {linkedCompany.legalName && <Row label="Legal name">{linkedCompany.legalName}</Row>}
            {linkedCompany.phone && <Row label="Phone">{linkedCompany.phone}</Row>}
            {linkedCompany.website && <Row label="Website">{linkedCompany.website}</Row>}
            {address && (
              <Row label="Address">
                {[address.line1, address.line2, `${address.city}, ${address.state} ${address.zip}`].filter(Boolean).join(", ")}
              </Row>
            )}
          </dl>
        ) : (
          <p className="text-sm text-ink-muted">Not linked to a company account yet.</p>
        )}
      </Card>

      <Card title="Directory details">
        <dl>
          <Row label="Contact">{vendor.contactName || "—"}</Row>
          <Row label="Email">{publicContactEmail(vendor.email)}</Row>
          {vendor.phone && <Row label="Phone">{vendor.phone}</Row>}
          <Row label="Trades">{vendor.trades.join(", ") || "—"}</Row>
          {vendor.licenseNumber && (
            <Row label="License">
              {vendor.licenseNumber}
              {vendor.licenseState ? ` (${vendor.licenseState})` : ""}
            </Row>
          )}
        </dl>
      </Card>

      <ConfirmDialog
        open={confirming}
        title={`Confirm payee for ${vendor.name}?`}
        payee={payee.currentEmail ?? ""}
        payeeLabel="Payout PayPal email"
        effect={`Future payouts will go to ${payee.currentEmail ?? ""}. Only confirm an email you have verified with ${vendor.name}.`}
        confirmLabel="Confirm payee"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          if (payee.currentEmail === null) return;
          await confirmPayee({ vendorId: vendor._id, email: payee.currentEmail });
          setConfirming(false);
          toast.success(`Payee confirmed for ${vendor.name}.`);
        }}
      />
    </div>
  );
}
