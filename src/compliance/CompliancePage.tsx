import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { ComplianceKind } from "../../convex/compliance/validators";
import { COMPLIANCE_KIND_LABEL, COMPUTED_STATUS_LABEL, REJECTION_REASON_MAX, type ComputedStatus } from "../../convex/lib/complianceRules";
import { downloadBlob } from "../billing/sovFile";
import { getErrorMessage } from "../lib/errors";
import { fetchAuthenticatedFile } from "../lib/storedFile";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, Field, PageHeader, StatusPill, formatCents, formatDate, formatDateTime, useToast } from "../ui";
import { inputClass } from "../ui/Field";
import { ComplianceUploadDialog } from "./ComplianceUploadForm";

type Worklist = FunctionReturnType<typeof api.compliance.items.gcComplianceWorklist>;
type VendorRow = Worklist["rows"][number];
type Item = VendorRow["items"][number];
type Summary = Pick<VendorRow, "status" | "reasons" | "byKind" | "currentIds" | "pendingCount">;

const CONVEX_ENV = {
  VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL as string | undefined,
};
const KINDS: ComplianceKind[] = ["coi", "w9", "license"];

function ComputedPill({ status }: { status: ComputedStatus }) {
  return <StatusPill status={status} label={COMPUTED_STATUS_LABEL[status]} />;
}

function Reasons({ reasons }: { reasons: Summary["reasons"] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-muted" data-testid="compliance-reasons">
      {reasons.map((r, i) => (
        <li key={i}>{r.message}</li>
      ))}
    </ul>
  );
}

function useDocumentDownload() {
  const token = useAuthToken();
  return async (doc: { downloadPath: string; fileName: string }) => {
    const blob = await fetchAuthenticatedFile({ downloadPath: doc.downloadPath }, token, CONVEX_ENV);
    if (blob === null) throw new Error("Not found.");
    downloadBlob(doc.fileName, blob);
  };
}

function DocumentButton({ doc }: { doc: NonNullable<Item["document"]> }) {
  const download = useDocumentDownload();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        loadingLabel="Downloading…"
        leadingIcon={<Download aria-hidden="true" className="h-4 w-4" />}
        onClick={() => {
          setBusy(true);
          setError(null);
          download(doc)
            .catch((err: unknown) => setError(getErrorMessage(err, "The download failed. Please try again.")))
            .finally(() => setBusy(false));
        }}
      >
        View document
      </Button>
      <span className="text-xs text-ink-subtle">
        {doc.fileName} · {Math.max(1, Math.round(doc.sizeBytes / 1024))} KB
      </span>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Advisory CSLB line for a license record. A result always names its source and time and is never shown as a verification. */
function LicenseCheckLine({ item, canRun }: { item: Item; canRun: boolean }) {
  const run = useMutation(api.compliance.items.requestCslbLookup);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const license = item.license;
  if (license === null) return null;
  if (license.state !== "CA") {
    return (
      <p className="text-xs text-ink-muted" data-testid="license-manual">
        Manual record ({license.state}). No CSLB lookup for licenses outside California.
      </p>
    );
  }
  const c = item.cslb;
  let line: string;
  if (c === null) line = "CSLB lookup: not run yet";
  else if (c.phase === "running") line = "CSLB lookup running…";
  else if (c.succeeded) line = `CSLB lookup: ${c.statusLabel} · ${c.source} · ${formatDateTime(c.checkedAt)}`;
  else line = `CSLB lookup failed — check manually · ${formatDateTime(c.checkedAt)}`;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="license-cslb">
      <span className="text-xs text-ink-muted">{line}</span>
      {canRun && c?.phase !== "running" ? (
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          loadingLabel="Starting…"
          onClick={() => {
            setBusy(true);
            setError(null);
            run({ itemId: item._id })
              .catch((err: unknown) => setError(getErrorMessage(err, "The lookup could not be started.")))
              .finally(() => setBusy(false));
          }}
        >
          Run CSLB lookup
        </Button>
      ) : null}
      <span className="w-full text-xs text-ink-subtle">Advisory only: the lookup does not accept or reject the record.</span>
      {error ? (
        <span role="alert" className="w-full text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ItemDetails({ item }: { item: Item }) {
  const rows: [string, string][] = [];
  if (item.coi) {
    const c = item.coi;
    rows.push(
      ["Insurer", c.insurer],
      ["GL policy", c.glPolicyNumber],
      ["GL each occurrence", formatCents(c.glEachOccurrenceCents)],
      ["GL aggregate", formatCents(c.glAggregateCents)],
      ["Auto liability", formatCents(c.autoCents)],
      ["Umbrella", formatCents(c.umbrellaCents)],
      ["Workers' comp", c.workersComp ? "Yes" : "No"],
      ["Additional insured", c.additionalInsured ? "Yes" : "No"],
      ["Effective", formatDate(c.effectiveDate)],
      ["Expires", formatDate(c.expiryDate)],
    );
  }
  if (item.w9) rows.push(["Entity type", item.w9.entityLabel], ["TIN", item.w9.tinMasked], ["Signed", formatDate(item.w9.signedDate)]);
  if (item.license) {
    rows.push(
      ["License number", item.license.licenseNumber],
      ["State", item.license.state],
      ["Classification", item.license.classification],
      ["Expires", formatDate(item.license.expiryDate)],
    );
  }
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 sm:justify-start">
          <dt className="text-ink-subtle">{k}</dt>
          <dd className="text-right text-ink sm:text-left">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewControls({ item, vendorName }: { item: Item; vendorName: string }) {
  const review = useMutation(api.compliance.items.reviewComplianceItem);
  const toast = useToast();
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const label = COMPLIANCE_KIND_LABEL[item.kind];

  async function reject() {
    const trimmed = reason.trim();
    if (trimmed === "") {
      setReasonError("Enter a reason for the rejection.");
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await review({ itemId: item._id, decision: "reject", reason: trimmed });
      setRejecting(false);
      toast.success(`${label} rejected. ${vendorName} has been notified.`);
    } catch (err) {
      setReasonError(getErrorMessage(err, "The rejection could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => setConfirmAccept(true)}>
        Accept
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          setReason("");
          setReasonError(null);
          setRejecting(true);
        }}
      >
        Reject
      </Button>
      <ConfirmDialog
        open={confirmAccept}
        title={`Accept ${label.toLowerCase().replace("w-9", "W-9")}?`}
        payee={vendorName}
        payeeLabel="Vendor"
        effect="The record counts toward this vendor's compliance from now on. The decision can't be changed; a newer upload supersedes it."
        confirmLabel="Accept"
        onConfirm={async () => {
          await review({ itemId: item._id, decision: "accept" });
          setConfirmAccept(false);
          toast.success(`${label} accepted.`);
        }}
        onCancel={() => setConfirmAccept(false)}
      />
      <Dialog
        open={rejecting}
        title={`Reject ${label.toLowerCase().replace("w-9", "W-9")}`}
        description={`${vendorName} sees this reason and can upload a replacement.`}
        onClose={() => setRejecting(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void reject()}>
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" required error={reasonError ?? undefined}>
          {(control) => (
            <textarea
              ref={reasonRef}
              {...control}
              rows={3}
              maxLength={REJECTION_REASON_MAX}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(null);
              }}
              className={inputClass(Boolean(reasonError), "py-2")}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

function ItemCard({ item, gc, vendorName, current }: { item: Item; gc: boolean; vendorName: string; current: boolean }) {
  return (
    <li className="space-y-2 rounded-lg border border-line bg-surface p-3" data-testid="compliance-item" data-kind={item.kind} data-status={item.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{COMPLIANCE_KIND_LABEL[item.kind]}</span>
        <StatusPill status={item.status} />
        {current ? <span className="text-xs text-ink-subtle">Counts toward compliance</span> : null}
        {item.demoRecord ? <span className="text-xs text-ink-subtle">Demo record (no file)</span> : null}
      </div>
      <ItemDetails item={item} />
      <p className="text-xs text-ink-subtle">
        Uploaded {formatDate(item.createdAt)} by {item.uploadedByName}
        {item.reviewedAt !== null ? ` · ${item.status === "accepted" ? "Accepted" : "Rejected"} ${formatDate(item.reviewedAt)} by ${item.reviewedByName ?? "GC"}` : ""}
      </p>
      {item.rejectionReason ? <p className="text-xs text-rose-300">Reason: {item.rejectionReason}</p> : null}
      {item.kind === "license" ? <LicenseCheckLine item={item} canRun={gc} /> : null}
      <div className="flex flex-wrap items-start gap-3">
        {item.document ? <DocumentButton doc={item.document} /> : null}
        {gc && item.status === "pending_review" ? <ReviewControls item={item} vendorName={vendorName} /> : null}
      </div>
    </li>
  );
}

function ItemList({ items, gc, vendorName, currentIds }: { items: Item[]; gc: boolean; vendorName: string; currentIds: Summary["currentIds"] }) {
  if (items.length === 0) return <p className="text-sm text-ink-subtle">No records uploaded yet.</p>;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <ItemCard key={item._id} item={item} gc={gc} vendorName={vendorName} current={currentIds[item.kind] === item._id} />
      ))}
    </ul>
  );
}

function RequirementBadges({ summary }: { summary: Summary }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {KINDS.map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="text-ink-subtle">{COMPLIANCE_KIND_LABEL[k]}:</span>
          <ComputedPill status={summary.byKind[k]} />
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// GC

type Filter = "all" | "pending_review" | ComputedStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending_review", label: "Pending review" },
  { id: "expiring", label: "Expiring" },
  { id: "expired", label: "Expired" },
  { id: "missing", label: "Missing" },
  { id: "non_compliant", label: "Not compliant" },
  { id: "compliant", label: "Compliant" },
];

const matches = (r: VendorRow, f: Filter) => f === "all" || (f === "pending_review" ? r.pendingCount > 0 : r.status === f);

function GcCompliance() {
  const data = useQuery(api.compliance.items.gcComplianceWorklist, {});
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  if (data === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading compliance…
      </p>
    );
  }
  const rows = data.rows.filter((r) => matches(r, filter));
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        title="Compliance & waivers"
        description="Certificates of insurance, W-9s and contractor licenses from your subs, checked against each subcontract's insurance terms."
      />
      <div role="group" aria-label="Filter vendors" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count = data.rows.filter((r) => matches(r, f.id)).length;
          return (
            <Button key={f.id} size="sm" variant={filter === f.id ? "primary" : "secondary"} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} ({count})
            </Button>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={data.rows.length === 0 ? "No subs on your projects yet" : "No vendors match this filter"}
          description={data.rows.length === 0 ? "Subs appear here once they join a project." : "Choose another filter to see more vendors."}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const key = `${r.projectId}:${r.vendorId}`;
            const expanded = open === key;
            return (
              <li key={key}>
                <Card padded data-testid="compliance-vendor-row" data-status={r.status}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{r.vendorName}</p>
                      <p className="text-xs text-ink-subtle">
                        {r.projectTitle}
                        {r.projectState ? ` (${r.projectState})` : ""}
                        {r.pendingCount > 0 ? ` · ${r.pendingCount} pending review` : ""}
                      </p>
                      <Reasons reasons={r.reasons} />
                    </div>
                    <div className="flex items-center gap-2">
                      <ComputedPill status={r.status} />
                      <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}>
                        {expanded ? "Hide records" : "Review records"}
                      </Button>
                    </div>
                  </div>
                  {expanded ? (
                    <div className="mt-3 space-y-3">
                      <RequirementBadges summary={r} />
                      <p className="text-xs text-ink-subtle">
                        Required by {r.requirementsSource ? `subcontract ${r.requirementsSource.agreementNumber}` : "the default terms"}: GL{" "}
                        {formatCents(r.requirements.glEachOccurrenceCents)} each / {formatCents(r.requirements.glAggregateCents)} aggregate, auto{" "}
                        {formatCents(r.requirements.autoCents)}, umbrella {formatCents(r.requirements.umbrellaCents)}
                        {r.requirements.workersComp ? ", workers' comp" : ""}
                        {r.requirements.additionalInsured ? ", additional insured" : ""}.
                      </p>
                      <ItemList items={r.items} gc vendorName={r.vendorName} currentIds={r.currentIds} />
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sub

function SubProject({ projectId }: { projectId: string }) {
  const data = useQuery(api.compliance.items.subProjectCompliance, { projectId });
  const toast = useToast();
  const [uploading, setUploading] = useState<ComplianceKind | null>(null);
  if (data === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading…
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <Card
        title={data.projectTitle}
        description="Only records your GC has accepted count. A newer accepted record replaces the older one."
        actions={<ComputedPill status={data.status} />}
      >
        <RequirementBadges summary={data} />
        <Reasons reasons={data.reasons} />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setUploading("coi")}>
            Upload certificate of insurance
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setUploading("w9")}>
            Upload W-9
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setUploading("license")}>
            Upload contractor license
          </Button>
        </div>
      </Card>
      <Card title="Your records" headingLevel={3}>
        <ItemList items={data.items} gc={false} vendorName={data.companyName} currentIds={data.currentIds} />
      </Card>
      <ComplianceUploadDialog
        open={uploading !== null}
        kind={uploading ?? "coi"}
        projectId={projectId}
        onClose={() => setUploading(null)}
        onUploaded={(message) => {
          setUploading(null);
          toast.success(message);
        }}
      />
    </div>
  );
}

function SubCompliance() {
  const data = useQuery(api.compliance.items.subComplianceOverview, {});
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (data && projectId === null && data.rows.length > 0) setProjectId(data.rows[0].projectId);
  }, [data, projectId]);
  if (data === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading compliance…
      </p>
    );
  }
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Compliance" description="Upload your certificate of insurance, W-9 and contractor license for each project. Your GC reviews each one." />
      {data.rows.length === 0 ? (
        <EmptyState title="No projects yet" description="Once a GC adds your company to a project, you can upload compliance records for it here." />
      ) : (
        <>
          <Field label="Project">
            {(control) => (
              <select {...control} value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)} className={inputClass(false, "sm:max-w-md")}>
                {data.rows.map((r) => (
                  <option key={r.projectId} value={r.projectId}>
                    {r.projectTitle}
                    {r.gcName ? ` · ${r.gcName}` : ""} · {COMPUTED_STATUS_LABEL[r.status]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {projectId ? <SubProject key={projectId} projectId={projectId} /> : null}
        </>
      )}
    </div>
  );
}

export function CompliancePage({ role }: { role: "gc" | "sub" | "owner" }) {
  if (role === "gc") return <GcCompliance />;
  if (role === "sub") return <SubCompliance />;
  return null;
}
