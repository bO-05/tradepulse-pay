import { useConvex, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Button, ConfirmDialog, EmptyState, PageHeader, StatusPill, Table, useToast, type TableColumn } from "../ui";
import { inputClass } from "../ui/Field";
import { vendorHash } from "../auth/navigation";
import { ImportVendorsDialog } from "./ImportVendorsDialog";
import { downloadCsv, vendorsToCsv } from "./vendorCsv";
import { VendorFormDialog, type EditableVendor } from "./VendorFormDialog";

type Vendor = FunctionReturnType<typeof api.vendors.listVendorsPage>["page"][number];
type Filter = "active" | "inactive" | "all";

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 500;

/** GC company vendor directory: list, filter, add, edit, deactivate, CSV import and export. */
export function VendorsPage() {
  const convex = useConvex();
  const summary = useQuery(api.vendors.directorySummary, {});
  const setStatus = useMutation(api.vendors.setVendorStatus);
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("active");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EditableVendor | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deactivating, setDeactivating] = useState<Vendor | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = search.trim();
  const list = usePaginatedQuery(
    api.vendors.listVendorsPage,
    { status: filter, ...(query ? { search: query } : {}) },
    { initialNumItems: PAGE_SIZE },
  );

  if (summary === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading vendors…</p>;

  const exportCsv = async () => {
    setExporting(true);
    try {
      // Every page of active vendors, so the file is complete however large the directory is.
      const active: Vendor[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: FunctionReturnType<typeof api.vendors.listVendorsPage> = await convex.query(api.vendors.listVendorsPage, {
          status: "active",
          paginationOpts: { numItems: EXPORT_PAGE_SIZE, cursor },
        });
        active.push(...page.page);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      const csv = await vendorsToCsv(active);
      downloadCsv("vendors.csv", csv);
    } catch (err) {
      toast.error(err, "We couldn't export the vendors.");
    } finally {
      setExporting(false);
    }
  };

  const reactivate = async (v: Vendor) => {
    try {
      await setStatus({ vendorId: v._id, status: "active" });
      toast.success(`${v.name} is active again.`);
    } catch (err) {
      toast.error(err, "We couldn't reactivate the vendor.");
    }
  };

  const addButton = <Button onClick={() => setAdding(true)}>Add vendor</Button>;
  const importButton = (
    <Button variant="secondary" onClick={() => setImporting(true)}>
      Import CSV
    </Button>
  );

  const columns: TableColumn<Vendor>[] = [
    {
      key: "name",
      header: "Vendor",
      render: (v) => (
        <span className="flex flex-col">
          <a href={vendorHash(v._id)} className="font-semibold text-emerald-300 hover:underline">
            {v.name}
          </a>
          {v.contactName && <span className="text-xs text-ink-subtle">{v.contactName}</span>}
        </span>
      ),
    },
    { key: "trades", header: "Trades", value: (v) => v.trades.join(", ") },
    {
      key: "contact",
      header: "Contact",
      render: (v) => (
        <span className="flex flex-col break-all">
          <span>{v.email}</span>
          {v.phone && <span className="text-xs text-ink-subtle">{v.phone}</span>}
        </span>
      ),
    },
    { key: "license", header: "License", value: (v) => (v.licenseNumber ? `${v.licenseNumber}${v.licenseState ? ` (${v.licenseState})` : ""}` : "") },
    {
      key: "status",
      header: "Status",
      render: (v) => (
        <span className="flex flex-wrap gap-1">
          <StatusPill status={v.status} />
          {v.linked && <StatusPill status="linked" label="Linked · company account" />}
          {v.payeeStatus !== "none" && <StatusPill status={`payee_${v.payeeStatus}`} />}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      cardLabel: "Actions",
      align: "right",
      render: (v) => (
        <span className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditing(v)} aria-label={`Edit ${v.name}`}>
            Edit
          </Button>
          {v.status === "active" ? (
            <Button size="sm" variant="ghost" onClick={() => setDeactivating(v)} aria-label={`Deactivate ${v.name}`}>
              Deactivate
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void reactivate(v)} aria-label={`Reactivate ${v.name}`}>
              Reactivate
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Vendors"
        description="Your company's subcontractor directory. Add bidders to trade packages from here."
        actions={
          summary.hasVendors ? (
            <>
              {addButton}
              {importButton}
              <Button variant="secondary" onClick={() => void exportCsv()} loading={exporting} loadingLabel="Exporting…" disabled={!summary.hasActive}>
                Export CSV
              </Button>
            </>
          ) : undefined
        }
      />
      {!summary.hasVendors ? (
        <EmptyState
          title="No vendors yet"
          description="Add the subcontractors you work with, or import them from a CSV file."
          action={addButton}
          secondaryAction={importButton}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div role="group" aria-label="Vendor status filter" className="flex gap-1 rounded-lg border border-line p-1">
              {(
                [
                  ["active", "Active"],
                  ["inactive", "Inactive"],
                  ["all", "All"],
                ] as [Filter, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  onClick={() => setFilter(id)}
                  className={`rounded-md px-3 py-1.5 text-sm ${filter === id ? "bg-emerald-700/40 text-emerald-100" : "text-ink-muted hover:bg-surface-raised"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="vendor-search" className="text-xs text-ink-subtle">
                Search
              </label>
              <input
                id="vendor-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, email or trade"
                className={inputClass(false, "w-64")}
              />
            </div>
          </div>
          {list.status === "LoadingFirstPage" ? (
            <p role="status" className="text-sm text-ink-subtle">Loading vendors…</p>
          ) : (
            <Table
              caption="Vendors"
              columns={columns}
              rows={list.results}
              rowKey={(v) => v._id}
              empty={
                <p className="py-6 text-center text-sm text-ink-subtle">
                  {filter === "inactive" && query === "" ? "No inactive vendors." : "No vendors match."}
                </p>
              }
            />
          )}
          {(list.status === "CanLoadMore" || list.status === "LoadingMore") && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => list.loadMore(PAGE_SIZE)} loading={list.status === "LoadingMore"} loadingLabel="Loading…">
                Show more vendors
              </Button>
            </div>
          )}
        </>
      )}
      <VendorFormDialog open={adding || editing !== null} vendor={editing} onClose={() => (setAdding(false), setEditing(null))} />
      <ImportVendorsDialog open={importing} onClose={() => setImporting(false)} />
      <ConfirmDialog
        open={deactivating !== null}
        title={`Deactivate ${deactivating?.name ?? "vendor"}?`}
        effect="It will be hidden from the vendor list and can't be added as a new bidder. Packages that already include it keep it, and you can reactivate it at any time."
        confirmLabel="Deactivate"
        tone="danger"
        onCancel={() => setDeactivating(null)}
        onConfirm={async () => {
          if (!deactivating) return;
          await setStatus({ vendorId: deactivating._id, status: "inactive" });
          toast.success(`${deactivating.name} deactivated.`);
          setDeactivating(null);
        }}
      />
    </div>
  );
}
