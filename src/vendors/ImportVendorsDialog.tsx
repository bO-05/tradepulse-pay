import { useMutation } from "convex/react";
import { useState, type ChangeEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { VendorCsvPreview } from "../../convex/lib/vendorRules";
import { getErrorMessage } from "../lib/errors";
import { Button, Dialog, useToast } from "../ui";
import { VENDOR_CSV_TEMPLATE_HEADER, parseVendorCsv } from "./vendorCsv";

type ImportResult = { created: number; duplicates: { row: number; name: string }[]; errors: { row: number; message: string }[] };

/** Choose a CSV → preview valid rows, row errors and already-existing vendors → confirm import. */
export function ImportVendorsDialog({ open, existingEmails, onClose }: { open: boolean; existingEmails: string[]; onClose: () => void }) {
  if (!open) return null;
  return <ImportBody existingEmails={existingEmails} onClose={onClose} />;
}

function ImportBody({ existingEmails, onClose }: { existingEmails: string[]; onClose: () => void }) {
  const importVendors = useMutation(api.vendors.importVendors);
  const toast = useToast();
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<VendorCsvPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setPreview(null);
    setResult(null);
    setFileError(null);
    if (!file) return;
    setFileName(file.name);
    setReading(true);
    try {
      const parsed = await parseVendorCsv(file, existingEmails);
      if (parsed.ok) setPreview(parsed.preview);
      else setFileError(parsed.message);
    } catch (err) {
      setFileError(getErrorMessage(err, "We couldn't read this file. Save it as CSV (UTF-8) and try again."));
    } finally {
      setReading(false);
    }
  };

  const confirm = async () => {
    if (!preview || preview.valid.length === 0 || importing) return;
    setImporting(true);
    try {
      const res = await importVendors({ rows: preview.valid.map((r) => ({ row: r.row, ...r.vendor })) });
      setResult(res);
      setPreview(null);
      toast.success(`Imported ${res.created} vendor${res.created === 1 ? "" : "s"}.`);
    } catch (err) {
      setFileError(getErrorMessage(err, "The import failed. No vendors were added."));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open
      title="Import vendors from CSV"
      description={
        <>
          Header row: <code className="break-all font-mono text-xs">{VENDOR_CSV_TEMPLATE_HEADER}</code>. Separate several trades with
          semicolons. Up to 2 MB and 1,000 rows.
        </>
      }
      onClose={onClose}
      footer={
        result ? (
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={confirm} loading={importing} loadingLabel="Importing…" disabled={!preview || preview.valid.length === 0}>
              {preview ? `Import ${preview.valid.length} vendor${preview.valid.length === 1 ? "" : "s"}` : "Import"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm">
        {!result && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="vendor-import-file" className="font-medium text-ink">
              CSV file
            </label>
            <input id="vendor-import-file" type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm text-ink-muted" />
            {reading && <p role="status" className="text-ink-subtle">Reading {fileName}…</p>}
          </div>
        )}
        {fileError && (
          <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-rose-200">
            {fileError}
          </p>
        )}
        {preview && <PreviewView preview={preview} />}
        {result && (
          <div role="status" className="space-y-2" data-testid="vendor-import-result">
            <p className="font-semibold text-ink">
              Imported {result.created} vendor{result.created === 1 ? "" : "s"}.
            </p>
            {result.duplicates.length > 0 && (
              <p className="text-ink-subtle">{result.duplicates.length} already in your directory and skipped.</p>
            )}
            {result.errors.length > 0 && (
              <ul className="list-disc pl-5 text-rose-200">
                {result.errors.map((e) => (
                  <li key={e.row}>{e.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PreviewView({ preview }: { preview: VendorCsvPreview }) {
  return (
    <div className="space-y-4" data-testid="vendor-import-preview">
      <section aria-labelledby="vendor-import-valid">
        <h3 id="vendor-import-valid" className="font-semibold text-ink">
          Ready to import ({preview.valid.length})
        </h3>
        {preview.valid.length === 0 ? (
          <p className="text-ink-subtle">No valid rows.</p>
        ) : (
          <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
            {preview.valid.map((r) => (
              <li key={r.row} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                <span>
                  <span className="text-ink-subtle">Row {r.row}:</span> <span className="font-medium">{r.vendor.name}</span>
                </span>
                <span className="text-ink-subtle">
                  {r.vendor.trades.join(", ")} · {r.vendor.email}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {preview.errors.length > 0 && (
        <section aria-labelledby="vendor-import-errors">
          <h3 id="vendor-import-errors" className="font-semibold text-rose-200">
            Rows with errors, not imported ({preview.errors.length})
          </h3>
          <ul className="mt-1 list-disc pl-5 text-rose-200">
            {preview.errors.map((e) => (
              <li key={e.row}>{e.message}</li>
            ))}
          </ul>
        </section>
      )}
      {preview.duplicates.length > 0 && (
        <section aria-labelledby="vendor-import-dupes">
          <h3 id="vendor-import-dupes" className="font-semibold text-amber-200">
            Already in your directory, skipped ({preview.duplicates.length})
          </h3>
          <ul className="mt-1 list-disc pl-5 text-amber-100">
            {preview.duplicates.map((d) => (
              <li key={d.row}>
                Row {d.row}: {d.name} ({d.email}) already exists.
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
