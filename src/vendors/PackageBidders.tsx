import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { FormEvent, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { getErrorMessage } from "../lib/errors";
import { Button, Dialog, EmptyState, StatusPill, Tabs, focusFirstInvalid, useToast } from "../ui";
import { inputClass } from "../ui/Field";
import { PackageBidsPanel, PackageQuestionsPanel } from "../bids/PackageBidsPanel";
import { BidderRfqStatus, PackageBidderMessages } from "./BidderRfqStatus";
import { RfqSendDialog } from "./RfqSendDialog";
import { RFQ_EMAIL_LABELS } from "./rfqLabels";
import { EMPTY_VENDOR_FORM, VendorFormFields, serverVendorError, vendorFormArgs, type VendorFormErrors, type VendorFormState } from "./VendorFormFields";

type Pkg = { _id: Id<"tradePackages">; csiDivision: string; tradeName: string };

/** A trade package's bidders, each tied to a vendor directory entry. */
export function PackageBidders({ pkg, readOnly }: { pkg: Pkg; readOnly?: boolean }) {
  const bidders = useQuery(api.contractors.listByPackage, { tradePackageId: pkg._id });
  const bidderVendorIds = [...new Set((bidders ?? []).map((b) => b.vendorId).filter((id): id is Id<"vendors"> => id !== undefined))];
  const vendors = useQuery(api.vendors.vendorSummaries, bidders === undefined ? "skip" : { vendorIds: bidderVendorIds.slice(0, 500) });
  const [open, setOpen] = useState(false);
  const [rfqReview, setRfqReview] = useState<{ contractorIds?: Id<"contractors">[] } | null>(null);
  if (bidders === undefined || vendors === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading bidders…</p>;
  const vendorById = new Map(vendors.map((v) => [v.requestedId, v]));
  const addButton = readOnly ? null : (
    <Button size="sm" onClick={() => setOpen(true)}>
      Add from directory
    </Button>
  );
  return (
    <section aria-label={`Bidders for ${pkg.csiDivision} ${pkg.tradeName}`} className="mt-2 space-y-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Bidders ({bidders.length})</h4>
        {bidders.length > 0 && (
          <span className="flex flex-wrap gap-2">
            {!readOnly && (
              <Button size="sm" variant="secondary" onClick={() => setRfqReview({})}>
                Send RFQ
              </Button>
            )}
            {addButton}
          </span>
        )}
      </div>
      {bidders.length === 0 ? (
        <EmptyState headingLevel={3} title="No bidders yet" description="Add subcontractors from your vendor directory or create a new vendor." action={addButton} />
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="package-bidders">
          {bidders.map((b) => {
            const vendor = b.vendorId ? vendorById.get(b.vendorId) : undefined;
            return (
              <li key={b._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-col">
                  <span className="font-semibold">{vendor?.name ?? b.companyName}</span>
                  <span className="break-all text-xs text-ink-subtle">{b.contactEmail}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {!(b.rfqStatus in RFQ_EMAIL_LABELS) && <StatusPill status={b.rfqStatus} />}
                  {b.linkedCompanyId && <StatusPill status="linked" label="Linked · company account" />}
                  {vendor?.status === "inactive" && <StatusPill status="inactive" label="Inactive vendor" />}
                </span>
                <BidderRfqStatus bidder={b} readOnly={readOnly} onRetry={() => setRfqReview({ contractorIds: [b._id] })} />
              </li>
            );
          })}
        </ul>
      )}
      {bidders.length > 0 && <PackageBidsPanel tradePackageId={pkg._id} bidders={bidders} readOnly={readOnly} />}
      {bidders.length > 0 && <PackageQuestionsPanel tradePackageId={pkg._id} readOnly={readOnly} />}
      {bidders.length > 0 && <PackageBidderMessages tradePackageId={pkg._id} bidders={bidders} />}
      {rfqReview && (
        <RfqSendDialog
          tradePackageId={pkg._id}
          contractorIds={rfqReview.contractorIds}
          title={`Send RFQ · ${pkg.csiDivision} ${pkg.tradeName}`}
          onClose={() => setRfqReview(null)}
        />
      )}
      {open && (
        <AddBiddersDialog
          pkg={pkg}
          bidderVendorIds={new Set(bidderVendorIds)}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

const PICKER_PAGE_SIZE = 50;

function AddBiddersDialog({
  pkg,
  bidderVendorIds,
  onClose,
}: {
  pkg: Pkg;
  bidderVendorIds: Set<Id<"vendors">>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("directory");
  return (
    <Dialog open title={`Add bidders · ${pkg.csiDivision} ${pkg.tradeName}`} onClose={onClose}>
      <Tabs
        label="Add bidders"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "directory", label: "From directory", content: <DirectoryPicker pkg={pkg} bidderVendorIds={bidderVendorIds} onDone={onClose} /> },
          { id: "new", label: "New vendor", content: <NewVendorBidder pkg={pkg} onDone={onClose} /> },
        ]}
      />
    </Dialog>
  );
}

function DirectoryPicker({
  pkg,
  bidderVendorIds,
  onDone,
}: {
  pkg: Pkg;
  bidderVendorIds: Set<Id<"vendors">>;
  onDone: () => void;
}) {
  const add = useMutation(api.contractors.addBiddersFromDirectory);
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<Id<"vendors">>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const summary = useQuery(api.vendors.directorySummary, {});
  const query = search.trim();
  const list = usePaginatedQuery(
    api.vendors.listVendorsPage,
    { status: "active", ...(query ? { search: query } : {}) },
    { initialNumItems: PICKER_PAGE_SIZE },
  );
  const active = list.results;

  const toggle = (id: Id<"vendors">) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const submit = async () => {
    if (picked.size === 0) {
      setError("Choose at least one vendor.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await add({ tradePackageId: pkg._id, vendorIds: [...picked] });
      toast.success(`Added ${picked.size} bidder${picked.size === 1 ? "" : "s"}.`);
      onDone();
    } catch (err) {
      setError(getErrorMessage(err, "We couldn't add the bidders. Try again."));
    } finally {
      setSaving(false);
    }
  };

  if (summary === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading vendors…</p>;
  if (!summary.hasActive) {
    return (
      <EmptyState
        headingLevel={3}
        title="No active vendors"
        description={
          <>
            Use <strong>New vendor</strong> to create one, or add vendors in <a href="#/vendors" className="underline">Vendors</a>.
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="bidder-picker-search" className="text-sm font-medium">
          Search vendors
        </label>
        <span id="bidder-picker-hint" className="text-xs text-ink-subtle">Name, email or trade, for example {pkg.csiDivision}.</span>
        <input id="bidder-picker-search" aria-describedby="bidder-picker-hint" type="search" value={search} onChange={(e) => setSearch(e.target.value)} className={inputClass(false)} />
      </div>
      <fieldset>
        <legend className="sr-only">Vendors</legend>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm" data-testid="bidder-picker">
          {active.map((v) => {
            const already = bidderVendorIds.has(v._id);
            const id = `bidder-pick-${v._id}`;
            return (
              <li key={v._id} className="flex items-center gap-3 px-3 py-2">
                <input id={id} type="checkbox" disabled={already} checked={already || picked.has(v._id)} onChange={() => toggle(v._id)} className="h-4 w-4" />
                <label htmlFor={id} className="flex flex-1 flex-col">
                  <span className="font-medium">{v.name}</span>
                  <span className="text-xs text-ink-subtle">
                    {v.trades.join(", ") || "No trades"} · {v.email}
                  </span>
                </label>
                {already && <span className="text-xs text-ink-subtle">Already a bidder</span>}
              </li>
            );
          })}
          {list.status === "LoadingFirstPage" && <li className="px-3 py-4 text-center text-ink-subtle">Loading vendors…</li>}
          {list.status !== "LoadingFirstPage" && active.length === 0 && <li className="px-3 py-4 text-center text-ink-subtle">No vendors match.</li>}
          {(list.status === "CanLoadMore" || list.status === "LoadingMore") && (
            <li className="px-3 py-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => list.loadMore(PICKER_PAGE_SIZE)} loading={list.status === "LoadingMore"} loadingLabel="Loading…">
                Show more vendors
              </Button>
            </li>
          )}
        </ul>
      </fieldset>
      {error && (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button onClick={() => void submit()} loading={saving} loadingLabel="Adding…">
          {picked.size > 0 ? `Add ${picked.size} bidder${picked.size === 1 ? "" : "s"}` : "Add bidders"}
        </Button>
      </div>
    </div>
  );
}

function NewVendorBidder({ pkg, onDone }: { pkg: Pkg; onDone: () => void }) {
  const create = useMutation(api.contractors.createVendorBidder);
  const toast = useToast();
  const [form, setForm] = useState<VendorFormState>({ ...EMPTY_VENDOR_FORM, trades: pkg.csiDivision });
  const [errors, setErrors] = useState<VendorFormErrors>({});
  const [saving, setSaving] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const parsed = vendorFormArgs(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      focusFirstInvalid(event.currentTarget);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await create({ tradePackageId: pkg._id, ...parsed.args });
      toast.success(`${parsed.args.name} added to your vendors and as a bidder.`);
      onDone();
    } catch (err) {
      setErrors(serverVendorError(err, getErrorMessage(err, "We couldn't add the vendor. Try again.")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate aria-label="New vendor bidder" className="space-y-4">
      <VendorFormFields idPrefix="bidder-vendor" form={form} errors={errors} onChange={setForm} />
      <p className="text-xs text-ink-subtle">The vendor is also saved to your Vendors directory.</p>
      <div className="flex justify-end">
        <Button type="submit" loading={saving} loadingLabel="Adding…">
          Create vendor and add bidder
        </Button>
      </div>
    </form>
  );
}
