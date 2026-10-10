import { useMutation, useQuery } from "convex/react";
import { useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import { DocumentDownloadButton } from "../documents/DocumentDownload";
import {
  SOV_FILE_TOO_LARGE,
  SOV_MAX_FILE_BYTES,
  formatDifference,
} from "../../convex/lib/sovRules";
import { getErrorMessage } from "../lib/errors";
import {
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  IconButton,
  MoneyInput,
  StatusPill,
  TextInput,
  formatCents,
  formatDate,
} from "../ui";
import type { SovImportResult } from "./sovFile";

type SovData = NonNullable<ReturnType<typeof useSovQuery>>;
type SovLine = SovData["lines"][number];

function useSovQuery(agreementId: string) {
  return useQuery(api.billing.sov.getSov, { agreementId });
}

export const SOV_LOCKED_NOTE = "Locked. Changes only through change orders";

/** The schedule of values for one agreement: GC edits the draft, everyone on the agreement reads the approved lines. */
export function SovPage({
  agreementId,
  backHash,
}: {
  agreementId: string;
  backHash: string;
}) {
  const sov = useSovQuery(agreementId);
  if (sov === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading schedule of values…
      </p>
    );
  }
  return (
    <div className="max-w-5xl space-y-4">
      <SovEditor sov={sov} />
      <a
        href={backHash}
        className="inline-block text-sm text-emerald-400 hover:text-emerald-300"
      >
        Back to agreement
      </a>
    </div>
  );
}

function SovEditor({ sov }: { sov: SovData }) {
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [exporting, setExporting] = useState(false);
  const moveLine = useMutation(api.billing.sov.moveSovLine);
  const deleteLine = useMutation(api.billing.sov.deleteSovLine);
  const approve = useMutation(api.billing.sov.approveSov);
  const reset = useMutation(api.billing.sov.resetSovFromBid);
  const approved = sov.status === "approved";
  const isGcView = sov.approvalProblem !== null || sov.canEdit;
  const showLines = isGcView || approved;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function exportXlsx() {
    setExporting(true);
    setError(null);
    try {
      const file = await import("./sovFile");
      const lines = sov.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        csiCode: l.csiCode,
        scheduledValueCents: l.scheduledValueCents,
      }));
      file.downloadBlob(file.sovFileName(sov.agreementNumber, "xlsx"), await file.sovToXlsxBlob(lines));
    } catch (err) {
      setError(getErrorMessage(err, "The export failed. Please try again."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card
      title="Schedule of values"
      description={`${sov.agreementNumber} · ${sov.subcontractorName} · ${sov.projectTitle}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill
            status={approved ? "approved" : "draft"}
            label={approved ? "Approved" : "Draft"}
          />
          {approved && sov.approvedAt !== null ? (
            <span
              className="text-xs text-slate-400"
              data-testid="sov-approved-by"
            >
              Approved by {sov.approvedByName ?? "the GC"} on{" "}
              {formatDate(sov.approvedAt)}
            </span>
          ) : null}
        </div>
      }
    >
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-400">
            {sov.netChangeOrdersCents !== 0 ? "Original contract sum" : "Contract sum"}
          </dt>
          <dd
            className="font-semibold tabular-nums"
            data-testid="sov-contract-sum"
          >
            {formatCents(sov.contractSumCents)}
          </dd>
        </div>
        {showLines ? (
          <>
            <div>
              <dt className="text-xs text-slate-400">SOV total</dt>
              <dd
                className="font-semibold tabular-nums"
                data-testid="sov-total"
              >
                {formatCents(sov.totalCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">
                Difference from contract sum
              </dt>
              <dd
                className={`font-semibold tabular-nums ${sov.differenceCents === 0 ? "text-emerald-300" : "text-amber-300"}`}
                data-testid="sov-difference"
              >
                {formatDifference(sov.differenceCents)}
              </dd>
            </div>
          </>
        ) : null}
        {sov.netChangeOrdersCents !== 0 ? (
          <>
            <div>
              <dt className="text-xs text-slate-400">Net change by change orders</dt>
              <dd className="font-semibold tabular-nums" data-testid="sov-net-change">
                {sov.netChangeOrdersCents > 0 ? "+" : ""}
                {formatCents(sov.netChangeOrdersCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Contract sum to date</dt>
              <dd className="font-semibold tabular-nums" data-testid="sov-contract-sum-to-date">
                {formatCents(sov.contractSumToDateCents)}
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      {approved ? (
        <p
          className="mt-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200"
          data-testid="sov-locked-note"
        >
          {SOV_LOCKED_NOTE}
        </p>
      ) : !isGcView ? (
        <p className="mt-3 text-sm text-slate-400">
          The GC has not approved this schedule of values yet.
        </p>
      ) : null}

      {sov.canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Upload className="h-4 w-4" />}
            onClick={() => setImportOpen(true)}
          >
            Import CSV or XLSX
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmReset(true)}
          >
            Reset from awarded bid
          </Button>
        </div>
      ) : null}
      {isGcView || approved ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {sov.lines.length > 0 ? (
            <DocumentDownloadButton kind="sov_csv" relatedId={sov.agreementId} label="Export CSV" variant="ghost" testId="sov-export-csv" />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<Download className="h-4 w-4" />}
            loading={exporting}
            disabled={sov.lines.length === 0}
            onClick={() => void exportXlsx()}
          >
            Export XLSX
          </Button>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200"
          data-testid="sov-error"
        >
          {error}
        </p>
      ) : null}

      {showLines ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid="sov-lines">
            <caption className="sr-only">
              Schedule of values lines for {sov.agreementNumber}
            </caption>
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Line
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Description
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  CSI code
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Scheduled value
                </th>
                {sov.canEdit ? (
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {sov.lines.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-slate-400">
                    No lines yet. Add a line or import a file.
                  </td>
                </tr>
              ) : null}
              {sov.lines.map((line, i) =>
                editingId === line._id ? (
                  <tr key={line._id} className="border-t border-slate-800">
                    <td colSpan={5} className="py-2">
                      <LineForm
                        initial={line}
                        submitLabel="Save line"
                        label={`Edit line ${line.lineNo}`}
                        onDone={() => setEditingId(null)}
                        lineId={line._id}
                        agreementId={sov.agreementId}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={line._id}
                    className="border-t border-slate-800"
                    data-testid="sov-line"
                  >
                    <td className="py-2 pr-3 tabular-nums">{line.lineNo}</td>
                    <td className="py-2 pr-3 break-words">
                      {line.description}
                      {line.fromChangeOrder ? (
                        <span
                          className="ml-2 rounded-full border border-sky-800 bg-sky-950 px-2 py-0.5 text-[11px] text-sky-200"
                          data-testid="sov-line-change-order"
                        >
                          From change order
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {line.csiCode || "—"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatCents(line.scheduledValueCents)}
                    </td>
                    {sov.canEdit && line.fromChangeOrder ? (
                      <td className="py-1 text-right text-xs text-slate-400">
                        Change order line
                      </td>
                    ) : sov.canEdit ? (
                      <td className="whitespace-nowrap py-1 text-right">
                        <IconButton
                          size="sm"
                          label={`Move line ${line.lineNo} up`}
                          icon={<ArrowUp className="h-4 w-4" />}
                          disabled={i === 0}
                          onClick={() =>
                            void run(() =>
                              moveLine({ lineId: line._id, direction: "up" }),
                            )
                          }
                        />
                        <IconButton
                          size="sm"
                          label={`Move line ${line.lineNo} down`}
                          icon={<ArrowDown className="h-4 w-4" />}
                          disabled={i === sov.lines.length - 1}
                          onClick={() =>
                            void run(() =>
                              moveLine({ lineId: line._id, direction: "down" }),
                            )
                          }
                        />
                        <IconButton
                          size="sm"
                          label={`Edit line ${line.lineNo}`}
                          icon={<Pencil className="h-4 w-4" />}
                          onClick={() => setEditingId(line._id)}
                        />
                        <IconButton
                          size="sm"
                          label={`Delete line ${line.lineNo}`}
                          icon={<Trash2 className="h-4 w-4" />}
                          onClick={() =>
                            void run(() => deleteLine({ lineId: line._id }))
                          }
                        />
                      </td>
                    ) : null}
                  </tr>
                ),
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 font-semibold">
                <td className="py-2 pr-3" colSpan={3}>
                  Total
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCents(sov.totalCents)}
                </td>
                {sov.canEdit ? <td /> : null}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {sov.canEdit ? (
        <div className="mt-4 rounded-lg border border-slate-800 p-3">
          <LineForm
            submitLabel="Add line"
            label="Add a line"
            agreementId={sov.agreementId}
          />
        </div>
      ) : null}

      {sov.excludedScopeNotes.length > 0 ? (
        <section className="mt-4 text-sm" aria-labelledby="sov-excluded-scope">
          <h3 id="sov-excluded-scope" className="mb-1 text-sm font-semibold">
            Excluded scope (not in contract)
          </h3>
          <ul className="list-disc pl-5 text-slate-300">
            {sov.excludedScopeNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {sov.canEdit ? (
        <div className="mt-4 space-y-2 border-t border-slate-800 pt-4">
          {sov.approvalProblem !== null ? (
            <p
              role="alert"
              className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-100"
              data-testid="sov-approval-problem"
            >
              {sov.approvalProblem}
            </p>
          ) : null}
          <Button
            disabled={sov.approvalProblem !== null}
            onClick={() => setConfirmApprove(true)}
          >
            Approve SOV
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmApprove}
        title="Approve the schedule of values?"
        amountCents={sov.totalCents}
        amountLabel="SOV total"
        payee={sov.subcontractorName}
        payeeLabel="Subcontractor"
        effect="Locks these lines for billing. After approval, changes are only possible through change orders."
        details={[
          { label: "Lines", value: String(sov.lines.length) },
          { label: "Contract sum", value: formatCents(sov.contractSumCents) },
        ]}
        confirmLabel="Approve SOV"
        onConfirm={async () => {
          await approve({ agreementId: sov.agreementId });
          setConfirmApprove(false);
        }}
        onCancel={() => setConfirmApprove(false)}
      />
      <ConfirmDialog
        open={confirmReset}
        title="Reset the draft from the awarded bid?"
        effect="Replaces every draft line with lines prefilled from the awarded bid. Your edits are discarded."
        confirmLabel="Reset draft"
        tone="danger"
        onConfirm={async () => {
          await reset({ agreementId: sov.agreementId });
          setConfirmReset(false);
        }}
        onCancel={() => setConfirmReset(false)}
      />
      {importOpen ? (
        <ImportDialog
          agreementId={sov.agreementId}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
    </Card>
  );
}

function LineForm({
  initial,
  submitLabel,
  label,
  agreementId,
  lineId,
  onDone,
}: {
  initial?: SovLine;
  submitLabel: string;
  label: string;
  agreementId: string;
  lineId?: string;
  onDone?: () => void;
}) {
  const add = useMutation(api.billing.sov.addSovLine);
  const update = useMutation(api.billing.sov.updateSovLine);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [csiCode, setCsiCode] = useState(initial?.csiCode ?? "");
  const [cents, setCents] = useState<number | null>(
    initial?.scheduledValueCents ?? null,
  );
  const [amountInvalid, setAmountInvalid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (description.trim() === "") return setError("Enter a description.");
    if (amountInvalid) return setError(amountInvalid);
    if (cents === null) return setError("Enter the scheduled value.");
    setBusy(true);
    try {
      const fields = { description, csiCode, scheduledValueCents: cents };
      if (lineId) await update({ lineId, ...fields });
      else {
        await add({ agreementId, ...fields });
        setDescription("");
        setCsiCode("");
        setCents(null);
      }
      onDone?.();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={label}
      noValidate
      className="space-y-2"
    >
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
        <TextInput
          label="Description"
          value={description}
          onChange={setDescription}
          maxLength={200}
          required
        />
        <TextInput
          label="CSI code"
          value={csiCode}
          onChange={setCsiCode}
          maxLength={32}
        />
        <MoneyInput
          label="Scheduled value"
          value={cents}
          onChange={setCents}
          onInvalidChange={setAmountInvalid}
          required
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy}>
          {submitLabel}
        </Button>
        {onDone && lineId ? (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function ImportDialog({
  agreementId,
  onClose,
}: {
  agreementId: string;
  onClose: () => void;
}) {
  const importLines = useMutation(api.billing.sov.importSovLines);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<SovImportResult | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onFile(file: File | undefined) {
    setResult(null);
    setServerError(null);
    if (!file) return;
    setFileName(file.name);
    if (file.size > SOV_MAX_FILE_BYTES) {
      setResult({
        ok: false,
        message: `${SOV_FILE_TOO_LARGE} This file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
        errors: [],
      });
      return;
    }
    setParsing(true);
    try {
      const { parseSovFile } = await import("./sovFile");
      setResult(await parseSovFile(file));
    } catch (err) {
      setResult({
        ok: false,
        message: getErrorMessage(err, "This file could not be read."),
        errors: [],
      });
    } finally {
      setParsing(false);
    }
  }

  async function onConfirm() {
    if (!result?.ok) return;
    setSaving(true);
    setServerError(null);
    try {
      await importLines({ agreementId, rows: result.rows });
      onClose();
    } catch (err) {
      setServerError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title="Import schedule of values"
      description="CSV or XLSX with the header line_no,description,csi_code,scheduled_value. Up to 2 MB and 1,000 rows. The imported rows replace every draft line."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!result?.ok}
            loading={saving}
            onClick={() => void onConfirm()}
          >
            {result?.ok
              ? `Replace draft with ${result.rows.length} lines`
              : "Replace draft lines"}
          </Button>
        </>
      }
    >
      <label className="block text-sm">
        <span className="text-xs text-slate-400">File (.csv or .xlsx)</span>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="mt-1 block w-full text-sm"
          data-testid="sov-import-file"
        />
      </label>
      {parsing ? (
        <p className="mt-3 text-sm text-slate-400" role="status">
          Reading {fileName}…
        </p>
      ) : null}
      {result && !result.ok ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200"
          data-testid="sov-import-errors"
        >
          <p className="font-semibold">{result.message}</p>
          {result.errors.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {result.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {result?.ok ? (
        <div className="mt-3" data-testid="sov-import-preview">
          <p className="text-sm text-slate-300">
            Preview of {result.rows.length} rows from {fileName}. Nothing is
            saved until you confirm.
          </p>
          <div className="mt-2 max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-400">
                <tr>
                  <th className="py-1 pr-2 font-medium">Line</th>
                  <th className="py-1 pr-2 font-medium">Description</th>
                  <th className="py-1 pr-2 font-medium">CSI</th>
                  <th className="py-1 text-right font-medium">
                    Scheduled value
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr
                    key={`${i}-${r.description}`}
                    className="border-t border-slate-800"
                  >
                    <td className="py-1 pr-2 tabular-nums">{i + 1}</td>
                    <td className="py-1 pr-2 break-words">{r.description}</td>
                    <td className="py-1 pr-2 font-mono">{r.csiCode ?? ""}</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatCents(r.scheduledValueCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-700 font-semibold">
                  <td colSpan={3} className="py-1">
                    Total
                  </td>
                  <td
                    className="py-1 text-right tabular-nums"
                    data-testid="sov-import-total"
                  >
                    {formatCents(result.totalCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : null}
      {serverError ? (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {serverError}
        </p>
      ) : null}
    </Dialog>
  );
}
