import { useAction, useMutation, useQuery } from "convex/react";
import { useRef, useState, type FormEvent } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { CSI_DIVISION_OPTIONS, normalizeInviteEmail, tradeName, type InviteEmailStatus } from "../../../convex/lib/inviteRules";
import { formatRetainagePercent } from "../../../convex/lib/retainageRules";
import { GC_PROJECTS_HASH, agreementHash, gcProjectHash, sovHash } from "../../auth/navigation";
import { getErrorMessage } from "../../lib/errors";
import { Button, Card, Field, MoneyInput, PageHeader, TextInput, focusFirstInvalid, formatCents, useToast } from "../../ui";
import { inputClass } from "../../ui/Field";
import { InviteResult } from "../../people/InviteDialog";
import { ProjectSetupFields } from "./ProjectSetupFields";
import {
  EMPTY_PROJECT_SETUP,
  effectiveRetainageBps,
  toProjectArgs,
  validateForm,
  visibleErrors,
  type ProjectSetupFormState,
} from "./projectSetupForm";
import {
  QUICK_START_MAX_LINES,
  QUICK_START_MIN_LINES,
  emptyQuickStartRows,
  newQuickStartRow,
  parsePastedSov,
  quickStartBidDeadline,
  quickStartHasErrors,
  quickStartSovErrors,
  quickStartSovTotalCents,
  quickStartSubErrors,
  type QuickStartSovRow,
  type QuickStartSub,
} from "./quickStartPlan";

type Step = 1 | 2 | 3 | 4 | 5;
type SetupKey = "project" | "package" | "sub" | "bid" | "agreement" | "sov" | "execute" | "invite";

type CreatedIds = {
  projectId?: Id<"projects">;
  tradePackageId?: Id<"tradePackages">;
  vendorId?: Id<"vendors">;
  contractorId?: Id<"contractors">;
  bidId?: Id<"bids">;
  agreementId?: Id<"agreements">;
};

type InviteResultData = {
  link: string;
  email: string;
  emailStatus: InviteEmailStatus;
  emailError: string | null;
};

const SETUP_STEPS: { key: SetupKey; label: string }[] = [
  { key: "project", label: "Create the job" },
  { key: "package", label: "Add the trade package" },
  { key: "sub", label: "Add the sub" },
  { key: "bid", label: "Record the subcontract bid" },
  { key: "agreement", label: "Generate the subcontract" },
  { key: "sov", label: "Import and approve the SOV" },
  { key: "execute", label: "Record the subcontract as executed" },
  { key: "invite", label: "Create the sub invite" },
];

const EMPTY_SUB: QuickStartSub = {
  companyName: "",
  contactName: "",
  email: "",
  csiDivision: "26 00 00",
  phone: "",
  licenseNumber: "",
};

function stepName(step: Step): string {
  if (step === 1) return "Job";
  if (step === 2) return "Sub";
  if (step === 3) return "Schedule of values";
  if (step === 4) return "Review";
  return "Done";
}

/** One job, one sub, one schedule of values, one invite. Additive; the full New project wizard stays available. */
export function QuickStartWizard() {
  const companyData = useQuery(api.companies.myCompany, {});
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<ProjectSetupFormState>(EMPTY_PROJECT_SETUP);
  const [sub, setSub] = useState<QuickStartSub>(EMPTY_SUB);
  const [rows, setRows] = useState<QuickStartSovRow[]>(() => emptyQuickStartRows());
  const [sendEmail, setSendEmail] = useState(true);
  const [jobSubmitted, setJobSubmitted] = useState(false);
  const [subSubmitted, setSubSubmitted] = useState(false);
  const [sovSubmitted, setSovSubmitted] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [jobServerError, setJobServerError] = useState<{ field?: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<SetupKey, "pending" | "running" | "done" | "error">>(() =>
    Object.fromEntries(SETUP_STEPS.map((item) => [item.key, "pending"])) as Record<SetupKey, "pending" | "running" | "done" | "error">,
  );
  const [created, setCreated] = useState<CreatedIds>({});
  const [invite, setInvite] = useState<InviteResultData | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const subFormRef = useRef<HTMLFormElement>(null);
  const idsRef = useRef<CreatedIds>({});
  const inFlight = useRef(false);

  const createProject = useMutation(api.projects.createProject);
  const createTradePackage = useMutation(api.tradePackages.createTradePackage);
  const createVendorBidder = useMutation(api.contractors.createVendorBidder);
  const submitDirectBid = useMutation(api.bids.submitDirectBid);
  const generateAgreement = useMutation(api.agreements.generateAgreement);
  const importSovLines = useMutation(api.billing.sov.importSovLines);
  const approveSov = useMutation(api.billing.sov.approveSov);
  const executeAgreement = useMutation(api.agreements.executeAgreement);
  const createInvite = useAction(api.invites.create);

  if (companyData === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading…</p>;
  const companyDefaultBps = companyData.company.defaultRetainageBps;
  const isDemo = companyData.company.isDemo;
  const jobErrors = validateForm(form, companyDefaultBps);
  const shownJobErrors = { ...visibleErrors(jobErrors, jobSubmitted) };
  if (jobServerError?.field && !(jobServerError.field in shownJobErrors)) {
    (shownJobErrors as Record<string, string>)[jobServerError.field] = jobServerError.message;
  }
  const subErrors = quickStartSubErrors(sub);
  const sovErrors = quickStartSovErrors(rows);
  const totalCents = quickStartSovTotalCents(rows);
  const retainageBps = effectiveRetainageBps(form, companyDefaultBps);

  const goNext = () => {
    setError(null);
    if (step === 1) {
      setJobSubmitted(true);
      if (Object.keys(jobErrors).length > 0) {
        focusFirstInvalid(formRef.current);
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setSubSubmitted(true);
      if (Object.keys(subErrors).length > 0) {
        focusFirstInvalid(subFormRef.current);
        return;
      }
      setStep(3);
      return;
    }
    if (step === 3) {
      setSovSubmitted(true);
      if (quickStartHasErrors(sovErrors)) return;
      setStep(4);
    }
  };

  const mark = (key: SetupKey, status: "pending" | "running" | "done" | "error") => {
    setProgress((prev) => ({ ...prev, [key]: status }));
  };

  const saveIds = (patch: Partial<CreatedIds>) => {
    idsRef.current = { ...idsRef.current, ...patch };
    setCreated(idsRef.current);
  };

  const applyPaste = () => {
    setPasteError(null);
    const parsed = parsePastedSov(pasteText);
    if (parsed.errors.length > 0) {
      setPasteError(parsed.errors.join(" "));
      return;
    }
    if (parsed.rows.length === 0) {
      setPasteError("Nothing to import. Paste one line per SOV row.");
      return;
    }
    setRows(
      parsed.rows.map((row) => ({
        ...newQuickStartRow(),
        description: row.description,
        amountCents: row.amountCents,
      })),
    );
    setSovSubmitted(false);
    toast.success(`${parsed.rows.length} SOV lines pasted.`);
  };

  const runSetup = async () => {
    if (inFlight.current) return;
    const finalJobErrors = validateForm(form, companyDefaultBps);
    const finalSubErrors = quickStartSubErrors(sub);
    const finalSovErrors = quickStartSovErrors(rows);
    if (Object.keys(finalJobErrors).length > 0) {
      setJobSubmitted(true);
      setStep(1);
      toast.error("Check the job details before creating the job.");
      return;
    }
    if (Object.keys(finalSubErrors).length > 0) {
      setSubSubmitted(true);
      setStep(2);
      toast.error("Check the sub details before creating the invite.");
      return;
    }
    if (quickStartHasErrors(finalSovErrors)) {
      setSovSubmitted(true);
      setStep(3);
      toast.error("Check the SOV lines before creating the job.");
      return;
    }
    const projectArgs = toProjectArgs(form, companyDefaultBps);
    const normalizedEmail = normalizeInviteEmail(sub.email);
    if (!normalizedEmail) {
      setSubSubmitted(true);
      setStep(2);
      toast.error("Enter a valid sub email.");
      return;
    }
    const packageName = tradeName(sub.csiDivision);
    const lineItems = rows.map((row) => ({
      item: row.description.trim(),
      unit: "LS",
      quantity: 1,
      unitCostCents: row.amountCents ?? 0,
      totalCostCents: row.amountCents ?? 0,
    }));
    let current: SetupKey = "project";
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setInviteError(null);
    setPasteError(null);
    setProgress(Object.fromEntries(SETUP_STEPS.map((item) => [item.key, "pending"])) as typeof progress);
    const ids = idsRef.current;
    try {
      if (!ids.projectId) {
        current = "project";
        setBusyLabel("Creating the job…");
        mark("project", "running");
        const projectId = (await createProject(projectArgs)) as Id<"projects">;
        saveIds({ projectId });
        mark("project", "done");
      } else mark("project", "done");

      if (!idsRef.current.tradePackageId) {
        current = "package";
        setBusyLabel("Adding the trade package…");
        mark("package", "running");
        const tradePackageId = await createTradePackage({
          projectId: idsRef.current.projectId!,
          csiDivision: sub.csiDivision,
          tradeName: packageName,
          budgetEstimate: projectArgs.contractValueCents / 100,
          scopeSummary: `Scope for ${packageName} on ${projectArgs.title}.`,
          mandatoryInclusions: [],
          bidDeadline: quickStartBidDeadline(),
        });
        saveIds({ tradePackageId });
        mark("package", "done");
      } else mark("package", "done");

      if (!idsRef.current.contractorId || !idsRef.current.vendorId) {
        current = "sub";
        setBusyLabel("Adding the sub…");
        mark("sub", "running");
        const added = await createVendorBidder({
          tradePackageId: idsRef.current.tradePackageId!,
          name: sub.companyName.trim(),
          trades: [sub.csiDivision],
          contactName: sub.contactName.trim(),
          email: normalizedEmail,
          ...(sub.phone.trim() ? { phone: sub.phone.trim() } : {}),
          ...(sub.licenseNumber.trim() ? { licenseNumber: sub.licenseNumber.trim() } : {}),
        });
        saveIds({ vendorId: added.vendorId, contractorId: added.contractorId });
        mark("sub", "done");
      } else mark("sub", "done");

      if (!idsRef.current.bidId) {
        current = "bid";
        setBusyLabel("Recording the subcontract bid…");
        mark("bid", "running");
        const bid = await submitDirectBid({
          tradePackageId: idsRef.current.tradePackageId!,
          contractorId: idsRef.current.contractorId!,
          subcontractorName: sub.companyName.trim(),
          baseAmountCents: totalCents,
          lineItems,
        });
        saveIds({ bidId: bid.bidId });
        mark("bid", "done");
      } else mark("bid", "done");

      if (!idsRef.current.agreementId) {
        current = "agreement";
        setBusyLabel("Generating the subcontract…");
        mark("agreement", "running");
        const agreement = await generateAgreement({
          bidId: idsRef.current.bidId!,
          tradePackageId: idsRef.current.tradePackageId!,
        });
        if (!agreement) throw new Error("The subcontract was not generated. Try again.");
        saveIds({ agreementId: agreement._id });
        mark("agreement", "done");
      } else mark("agreement", "done");

      if (progress.sov !== "done") {
        current = "sov";
        setBusyLabel("Importing and approving the SOV…");
        mark("sov", "running");
        await importSovLines({
          agreementId: idsRef.current.agreementId!,
          rows: rows.map((row) => ({
            description: row.description.trim(),
            csiCode: sub.csiDivision,
            scheduledValueCents: row.amountCents ?? 0,
          })),
        });
        await approveSov({ agreementId: idsRef.current.agreementId! });
        mark("sov", "done");
      } else mark("sov", "done");

      current = "execute";
      setBusyLabel("Recording the subcontract as executed…");
      mark("execute", "running");
      // Idempotent: an already-executed agreement returns success without changing it.
      await executeAgreement({ agreementId: idsRef.current.agreementId! });
      mark("execute", "done");

      if (!invite) {
        current = "invite";
        setBusyLabel("Creating the sub invite…");
        mark("invite", "running");
        try {
          const result = await createInvite({
            kind: "sub",
            email: normalizedEmail,
            projectId: idsRef.current.projectId!,
            vendorId: idsRef.current.vendorId!,
            sendEmail,
          });
          setInvite(result);
          mark("invite", "done");
        } catch (err) {
          mark("invite", "error");
          setInviteError(getErrorMessage(err, "The job and subcontract are ready, but the invite could not be created. Open People to create it."));
        }
      } else mark("invite", "done");

      setStep(5);
      toast.success("Quick start is set up.");
    } catch (err) {
      mark(current, "error");
      setError(
        getErrorMessage(
          err,
          "Quick start stopped before it finished. Nothing already created is lost; fix the problem and retry.",
        ),
      );
      toast.error(err, "Quick start stopped. You can retry from this screen.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      setBusyLabel(null);
    }
  };

  const canRetry = Boolean(created.projectId);
  const setupDone = step === 5;

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Quick start"
        description={setupDone ? "The job, subcontract, approved SOV and invite are ready." : `Step ${step} of 4: ${stepName(step)}`}
        back={{ href: GC_PROJECTS_HASH, label: "All projects" }}
        actions={
          <a href="#/all-projects/new" className="inline-flex min-h-touch items-center rounded-lg px-3 text-sm text-ink-subtle hover:text-ink">
            Use full new project setup
          </a>
        }
      />

      {!setupDone && (
        <ol aria-label="Quick start progress" className="grid gap-2 text-sm sm:grid-cols-4">
          {(["Job", "Sub", "Schedule of values", "Review"] as const).map((label, index) => {
            const number = (index + 1) as Step;
            const state = number < step ? "done" : number === step ? "current" : "pending";
            return (
              <li
                key={label}
                aria-current={state === "current" ? "step" : undefined}
                className={`rounded-lg border px-3 py-2 ${
                  state === "current"
                    ? "border-emerald-600 bg-emerald-950/50 text-emerald-100"
                    : state === "done"
                      ? "border-line text-ink-muted"
                      : "border-line text-ink-subtle"
                }`}
              >
                <span className="mr-2 font-semibold tabular-nums">{number}.</span>
                {label}
                {state === "done" ? " · done" : ""}
              </li>
            );
          })}
        </ol>
      )}

      {step === 1 && (
        <Card title="Job" description="The prime contract basics. You can change these later in Project settings.">
          <form ref={formRef} onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); goNext(); }} noValidate aria-label="Quick start job" className="space-y-5">
            <ProjectSetupFields
              form={form}
              onChange={(patch) => {
                setJobServerError(null);
                setForm((prev) => ({ ...prev, ...patch }));
              }}
              errors={shownJobErrors}
              companyDefaultBps={companyDefaultBps}
              idPrefix="quick-start-job"
              disabled={busy}
            />
            {jobServerError && !jobServerError.field && (
              <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
                {jobServerError.message}
              </p>
            )}
            <Button type="submit">Continue to the sub</Button>
          </form>
        </Card>
      )}

      {step === 2 && (
        <Card title="Sub" description="One subcontractor for this first pass. The vendor and bidder are added to your directory and this job.">
          <form ref={subFormRef} onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); goNext(); }} noValidate aria-label="Quick start sub" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                id="quick-start-sub-company"
                label="Subcontractor company"
                required
                value={sub.companyName}
                onChange={(companyName) => setSub((prev) => ({ ...prev, companyName }))}
                error={subSubmitted ? subErrors.companyName : undefined}
                placeholder="e.g. Eastbay Electric"
                maxLength={120}
              />
              <TextInput
                id="quick-start-sub-contact"
                label="Contact name"
                required
                value={sub.contactName}
                onChange={(contactName) => setSub((prev) => ({ ...prev, contactName }))}
                error={subSubmitted ? subErrors.contactName : undefined}
                placeholder="e.g. Nora Patel"
                maxLength={120}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                id="quick-start-sub-email"
                label="Contact email"
                required
                type="email"
                value={sub.email}
                onChange={(email) => setSub((prev) => ({ ...prev, email }))}
                error={subSubmitted ? subErrors.email : undefined}
                hint="The invite goes here. Demo companies get a copyable link instead of email."
                placeholder="name@company.com"
                autoComplete="email"
              />
              <Field id="quick-start-sub-trade" label="Trade" required error={submittedSubTrade(subSubmitted, subErrors.csiDivision)}>
                {(control) => (
                  <select
                    {...control}
                    value={sub.csiDivision}
                    onChange={(event) => setSub((prev) => ({ ...prev, csiDivision: event.target.value }))}
                    className={inputClass(Boolean(subSubmitted && subErrors.csiDivision))}
                  >
                    {CSI_DIVISION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                id="quick-start-sub-phone"
                label="Phone"
                value={sub.phone}
                onChange={(phone) => setSub((prev) => ({ ...prev, phone }))}
                error={subSubmitted ? subErrors.phone : undefined}
                placeholder="(510) 555-0142"
                maxLength={30}
                type="tel"
              />
              <TextInput
                id="quick-start-sub-license"
                label="License number"
                value={sub.licenseNumber}
                onChange={(licenseNumber) => setSub((prev) => ({ ...prev, licenseNumber }))}
                error={subSubmitted ? subErrors.licenseNumber : undefined}
                placeholder="Optional"
                maxLength={40}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Continue to the SOV</Button>
              <Button type="button" variant="secondary" onClick={() => setStep(1)} disabled={busy}>Back</Button>
            </div>
          </form>
        </Card>
      )}

      {step === 3 && (
        <Card
          title="Schedule of values"
          description={`Paste ${QUICK_START_MIN_LINES}–${QUICK_START_MAX_LINES} lines from a spreadsheet, or type them. These become the approved schedule-of-values lines the sub bills against.`}
        >
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-surface-raised p-3">
              <Field
                id="quick-start-paste"
                label="Paste from a spreadsheet"
                hint='One row per line: "Description, amount". A header row is ignored. Up to 8 lines.'
                error={pasteError ?? undefined}
              >
                {(control) => (
                  <textarea
                    {...control}
                    value={pasteText}
                    onChange={(event) => setPasteText(event.target.value)}
                    rows={3}
                    placeholder={"Rough-in, 22000\nTrim-out, 19500\nCloseout, 8250"}
                    className={inputClass(Boolean(pasteError), "font-mono text-xs")}
                  />
                )}
              </Field>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={applyPaste} disabled={busy || pasteText.trim() === ""}>
                  Use pasted lines
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRows(emptyQuickStartRows())} disabled={busy}>
                  Clear rows
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {rows.map((row, index) => (
                <div key={row.id} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-[1fr_180px_auto] sm:items-start">
                  <TextInput
                    id={`quick-start-sov-${index}-description`}
                    label={`Line ${index + 1}`}
                    required
                    value={row.description}
                    onChange={(description) => setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, description } : r))}
                    error={sovSubmitted ? sovErrors.rows[index]?.description : undefined}
                    placeholder="e.g. Rough-in"
                    maxLength={200}
                  />
                  <MoneyInput
                    id={`quick-start-sov-${index}-amount`}
                    label="Scheduled value"
                    required
                    value={row.amountCents}
                    onChange={(amountCents) => setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, amountCents } : r))}
                    error={sovSubmitted ? sovErrors.rows[index]?.amountCents : undefined}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="sm:mt-6"
                    onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                    disabled={busy || rows.length <= QUICK_START_MIN_LINES}
                    aria-label={`Remove line ${index + 1}`}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            {(sovSubmitted && (sovErrors.count || sovErrors.total)) && (
              <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
                {sovErrors.count ?? sovErrors.total}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
              <span>SOV total: <strong className="tabular-nums">{formatCents(totalCents)}</strong></span>
              <span className="text-ink-subtle">Retainage: <strong>{retainageBps !== null ? formatRetainagePercent(retainageBps) : "—"}</strong> on each pay app</span>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setRows((prev) => [...prev, newQuickStartRow()])}
                disabled={busy || rows.length >= QUICK_START_MAX_LINES}
              >
                Add a line
              </Button>
              <Button type="button" onClick={goNext} disabled={busy}>Review the setup</Button>
              <Button type="button" variant="secondary" onClick={() => setStep(2)} disabled={busy}>Back</Button>
            </div>
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card title="Review and create" description="One confirmation creates the job and subcontract, approves the SOV, records execution, and prepares the invite.">
          <div className="space-y-4">
            <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
              <SummaryRow label="Job" value={form.title || "—"} />
              <SummaryRow label="Owner" value={form.ownerName || "—"} />
              <SummaryRow label="Location" value={[form.city, form.state].filter(Boolean).join(", ") || "—"} />
              <SummaryRow label="Prime contract" value={form.contractValueCents !== null ? formatCents(form.contractValueCents) : "—"} />
              <SummaryRow label="Retainage" value={retainageBps !== null ? formatRetainagePercent(retainageBps) : "—"} />
              <SummaryRow label="Billing day" value={form.billingDay ? `Day ${form.billingDay}` : "—"} />
              <SummaryRow label="Sub" value={sub.companyName || "—"} />
              <SummaryRow label="Sub contact" value={[sub.contactName, sub.email].filter(Boolean).join(" · ") || "—"} />
              <SummaryRow label="Trade" value={`${sub.csiDivision} · ${tradeName(sub.csiDivision)}`} />
              <SummaryRow label="Subcontract / SOV total" value={formatCents(totalCents)} />
            </dl>

            <div className="rounded-lg border border-line p-3">
              <p className="text-sm font-semibold text-ink">SOV lines</p>
              <ul className="mt-2 divide-y divide-line text-sm">
                {rows.map((row, index) => (
                  <li key={row.id} className="flex justify-between gap-3 py-1.5">
                    <span>{index + 1}. {row.description}</span>
                    <span className="tabular-nums">{formatCents(row.amountCents ?? 0)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={sendEmail}
                onChange={(event) => setSendEmail(event.target.checked)}
                disabled={busy}
              />
              <span>
                <span className="font-semibold">Email the invite now</span>
                <span className="mt-1 block text-ink-subtle">
                  {isDemo
                    ? "Demo companies return a copyable invite link instead of email."
                    : "The sub gets a 7-day, one-use link. If email is blocked or the daily limit is reached, you'll get the link to share."}
                </span>
              </span>
            </label>

            <p role="note" className="rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
              This records the subcontract as executed in TradePulse Pay. External signature verification is still your responsibility.
            </p>

            {error && (
              <div role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
                <p>{error}</p>
                {canRetry && <p className="mt-1">Already-created steps are kept. Retry to continue where it stopped.</p>}
              </div>
            )}
            {busy && (
              <div role="status" aria-live="polite" className="rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm">
                <p className="font-semibold">{busyLabel ?? "Working…"}</p>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {SETUP_STEPS.map((item) => (
                    <li key={item.key} className="flex items-center gap-2 text-ink-subtle">
                      <ProgressDot status={progress[item.key]} />
                      {item.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" loading={busy} loadingLabel="Setting up…" onClick={() => void runSetup()}>
                {canRetry ? "Retry setup" : "Create job and invite sub"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setStep(3)} disabled={busy}>Back</Button>
            </div>
          </div>
        </Card>
      )}

      {setupDone && (
        <Card title="Ready" description="The sub can accept the invite and file a pay application after the SOV is approved (it is approved here).">
          <div className="space-y-4">
            <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
              <SummaryRow label="Job" value={form.title} />
              <SummaryRow label="Sub" value={sub.companyName} />
              <SummaryRow label="Subcontract" value={formatCents(totalCents)} />
              <SummaryRow label="Retainage" value={retainageBps !== null ? formatRetainagePercent(retainageBps) : "—"} />
            </dl>
            <div className="flex flex-wrap gap-2">
              {created.projectId && (
                <a href={gcProjectHash(created.projectId)} className="inline-flex min-h-touch items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover">
                  Open the job
                </a>
              )}
              {created.agreementId && (
                <a href={agreementHash(created.agreementId)} className="inline-flex min-h-touch items-center rounded-lg border border-line-strong px-4 text-sm font-semibold hover:bg-surface-raised">
                  Open the subcontract
                </a>
              )}
              {created.agreementId && (
                <a href={sovHash(created.agreementId)} className="inline-flex min-h-touch items-center rounded-lg border border-line-strong px-4 text-sm font-semibold hover:bg-surface-raised">
                  Open the SOV
                </a>
              )}
            </div>
            {invite ? (
              <div className="rounded-lg border border-line p-3">
                <p className="mb-2 text-sm font-semibold text-ink">Sub invite</p>
                <InviteResult result={invite} />
              </div>
            ) : (
              <div role="alert" className="rounded-lg border border-amber-700 bg-amber-950/50 px-3 py-2 text-sm text-amber-100">
                <p>{inviteError ?? "The invite was not created."}</p>
                {created.projectId && (
                  <a href={`#/people/${encodeURIComponent(created.projectId)}`} className="mt-2 inline-block underline">
                    Open People to create the invite
                  </a>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <a href={GC_PROJECTS_HASH} className="inline-flex min-h-touch items-center rounded-lg px-3 text-sm text-ink-subtle hover:text-ink">
                Back to all projects
              </a>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setStep(1);
                  setForm(EMPTY_PROJECT_SETUP);
                  setSub(EMPTY_SUB);
                  setRows(emptyQuickStartRows());
                  setCreated({});
                  idsRef.current = {};
                  setInvite(null);
                  setInviteError(null);
                  setProgress(Object.fromEntries(SETUP_STEPS.map((item) => [item.key, "pending"])) as typeof progress);
                  setJobSubmitted(false);
                  setSubSubmitted(false);
                  setSovSubmitted(false);
                }}
              >
                Start another job
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function submittedSubTrade(submitted: boolean, error: string | undefined): string | undefined {
  return submitted ? error : undefined;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="break-words text-right">{value}</dd>
    </div>
  );
}

function ProgressDot({ status }: { status: "pending" | "running" | "done" | "error" }) {
  const label = status === "done" ? "Done" : status === "running" ? "In progress" : status === "error" ? "Failed" : "Waiting";
  return (
    <span
      aria-label={label}
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        status === "done" ? "bg-emerald-500" : status === "running" ? "bg-amber-400" : status === "error" ? "bg-rose-500" : "bg-slate-600"
      }`}
    />
  );
}
