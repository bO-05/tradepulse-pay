import { useAuthToken } from "@convex-dev/auth/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { Download } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { DocumentKind } from "../../convex/documents/kinds";
import { downloadBlob } from "../billing/sovFile";
import { getErrorMessage } from "../lib/errors";
import { fetchAuthenticatedFile } from "../lib/storedFile";
import { Button, EmptyState, formatDate, type ButtonVariant } from "../ui";
import type { ButtonSize } from "../ui/Button";

const CONVEX_ENV = {
  VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL as string | undefined,
};

const POLL_MS = 600;
const POLL_LIMIT = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function useFetchDocument() {
  const token = useAuthToken();
  return async (doc: { downloadPath: string; fileName: string }) => {
    const blob = await fetchAuthenticatedFile({ downloadPath: doc.downloadPath }, token, CONVEX_ENV);
    if (blob === null) throw new Error("Not found.");
    downloadBlob(doc.fileName, blob);
  };
}

/**
 * Generates (or reuses) the server-side document of a record and downloads it through the
 * authenticated /api/documents route with the session token.
 */
export function DocumentDownloadButton({
  kind,
  relatedId,
  label,
  variant = "secondary",
  size = "sm",
  testId,
}: {
  kind: DocumentKind;
  relatedId: string;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  testId?: string;
}) {
  const convex = useConvex();
  const request = useMutation(api.documents.documents.requestDocument);
  const fetchDocument = useFetchDocument();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await request({ kind, relatedId });
      let doc = res.document;
      for (let i = 0; doc === null && i < POLL_LIMIT; i++) {
        await sleep(POLL_MS);
        doc = await convex.query(api.documents.documents.documentStatus, { kind, relatedId, inputsHash: res.inputsHash });
      }
      if (doc === null) throw new Error("The document is still being generated. Please try again in a moment.");
      await fetchDocument(doc);
    } catch (err) {
      setError(getErrorMessage(err, "The download failed. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        size={size}
        loading={busy}
        loadingLabel="Preparing…"
        leadingIcon={<Download aria-hidden="true" className="h-4 w-4" />}
        onClick={() => void run()}
        data-testid={testId}
      >
        {label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** The documents already generated on a project that the caller may download. */
export function ProjectDocumentsList({ projectId }: { projectId: string }) {
  const data = useQuery(api.documents.documents.listDocuments, { projectId });
  const fetchDocument = useFetchDocument();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (data === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading documents…
      </p>
    );
  }
  if (data.documents.length === 0) {
    return (
      <EmptyState
        title="No documents yet"
        description="PDFs and CSV exports appear here once someone downloads them from a pay app, change order, owner pay app or subcontract."
        headingLevel={3}
      />
    );
  }
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="documents-table">
          <caption className="sr-only">Project documents</caption>
          <thead className="text-left text-xs text-ink-subtle">
            <tr>
              <th className="py-2 pr-3 font-medium" scope="col">Document</th>
              <th className="py-2 pr-3 font-medium" scope="col">File</th>
              <th className="py-2 pr-3 font-medium" scope="col">Generated</th>
              <th className="py-2 pr-3 font-medium" scope="col">
                <span className="sr-only">Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.documents.map((d) => (
              <tr key={d._id} className="border-t border-line" data-testid="documents-row">
                <td className="py-2 pr-3">{d.label}</td>
                <td className="py-2 pr-3">
                  {d.fileName}
                  <span className="block text-xs text-ink-subtle">{Math.max(1, Math.round(d.sizeBytes / 1024))} KB</span>
                </td>
                <td className="py-2 pr-3">{formatDate(d.createdAt)}</td>
                <td className="py-2 pr-3 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busyId === d._id}
                    loadingLabel="Downloading…"
                    leadingIcon={<Download aria-hidden="true" className="h-4 w-4" />}
                    onClick={() => {
                      setBusyId(d._id);
                      setError(null);
                      fetchDocument(d)
                        .catch((err: unknown) => setError(getErrorMessage(err, "The download failed. Please try again.")))
                        .finally(() => setBusyId(null));
                    }}
                  >
                    Download
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.truncated ? <p className="text-xs text-ink-subtle">Showing the newest documents only.</p> : null}
    </div>
  );
}
