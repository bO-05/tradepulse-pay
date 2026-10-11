import { useRef, useState, type FormEvent } from "react";
import { Bell, FolderPlus, Settings } from "lucide-react";
import { Button } from "./Button";
import { Card } from "./Card";
import { ConfirmDialog } from "./ConfirmDialog";
import { DateText } from "./DateText";
import { EmptyState } from "./EmptyState";
import { focusFirstInvalid } from "./Field";
import { IconButton } from "./IconButton";
import { DateInput, MoneyInput, PercentInput, TextInput } from "./Inputs";
import { Money } from "./Money";
import { PageHeader } from "./PageHeader";
import { StatusPill } from "./StatusPill";
import { STATUS_LABELS } from "./statusLabels";
import { Table, type TableColumn } from "./Table";
import { Tabs } from "./Tabs";
import { ToastProvider, useToast } from "./Toast";

interface SampleLine {
  id: string;
  lineNo: number;
  description: string;
  scheduledCents: number;
  completedCents: number;
  status: string;
}

const LINES: SampleLine[] = [
  { id: "1", lineNo: 1, description: "Mobilization", scheduledCents: 1250000, completedCents: 1250000, status: "approved" },
  { id: "2", lineNo: 2, description: "Rough-in electrical", scheduledCents: 6000000, completedCents: 2412360, status: "under_review" },
  { id: "3", lineNo: 3, description: "Switchgear (stored materials)", scheduledCents: 3875050, completedCents: 0, status: "revision_requested" },
  { id: "4", lineNo: 4, description: "CO #1 — Added circuits", scheduledCents: -125000, completedCents: 0, status: "approved_as_noted" },
];

const COLUMNS: TableColumn<SampleLine>[] = [
  { key: "description", header: "Description", render: (r) => `${r.lineNo}. ${r.description}` },
  { key: "scheduled", header: "Scheduled value", kind: "money", value: (r) => r.scheduledCents },
  { key: "completed", header: "Completed to date", kind: "money", value: (r) => r.completedCents },
  { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
];

function FormDemo() {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [contract, setContract] = useState<number | null>(null);
  const [changeOrder, setChangeOrder] = useState<number | null>(-125000);
  const [retainage, setRetainage] = useState<number | null>(500);
  const [start, setStart] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Enter a project name.";
    if (contract === null) next.contract = "Enter the contract value.";
    if (!start) next.start = "Pick a start date.";
    setErrors(next);
    if (Object.keys(next).length) {
      focusFirstInvalid(formRef.current);
      toast.error("Fix the highlighted fields.");
      return;
    }
    toast.success(`Saved: contract ${contract} cents, retainage ${retainage} bps, change order ${changeOrder} cents.`);
  };

  return (
    <form ref={formRef} noValidate onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <TextInput label="Project name" required value={name} onChange={setName} error={errors.name} />
      <MoneyInput label="Contract value" required value={contract} onChange={setContract} error={errors.contract} hint="Dollars and cents" />
      <PercentInput label="Retainage" value={retainage} onChange={setRetainage} max={10} hint="At most 10%" />
      <MoneyInput label="Change order amount" allowNegative value={changeOrder} onChange={setChangeOrder} hint="Deductive change orders may be negative" />
      <DateInput label="Start date" required value={start} onChange={setStart} error={errors.start} />
      <div className="flex items-end">
        <Button type="submit">Save project</Button>
      </div>
      <p className="text-xs text-ink-subtle sm:col-span-2" data-testid="form-values">
        Stored: contract={String(contract)} retainageBps={String(retainage)} changeOrder={String(changeOrder)} start={start || "—"}
      </p>
    </form>
  );
}

function GalleryBody() {
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader
        title="UI kit"
        description="Development-only gallery of the src/ui design system. Not included in production builds."
        back={{ href: "#/", label: "Back to app" }}
        actions={
          <>
            <IconButton label="Notifications" icon={<Bell className="h-5 w-5" />} />
            <IconButton label="Settings" icon={<Settings className="h-5 w-5" />} />
          </>
        }
      />

      <div className="space-y-6">
        <Card title="Buttons">
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="ghost">Ghost</Button>
            <Button loading>Saving</Button>
            <Button size="sm" variant="secondary">
              Small
            </Button>
            <Button disabled>Disabled</Button>
          </div>
        </Card>

        <Card title="Money and dates">
          <ul className="space-y-1 text-sm text-ink">
            <li>
              Positive: <Money cents={123456} />
            </li>
            <li>
              Negative: <Money cents={-125000} />
            </li>
            <li>
              Large: <Money cents={123456789} />
            </li>
            <li>
              Date: <DateText value="2026-10-08" />
            </li>
            <li>
              Timestamp: <DateText value={Date.UTC(2026, 9, 8, 21, 39)} withTime />
            </li>
          </ul>
        </Card>

        <Card title="Status pills" description="Every label comes from src/ui/statusLabels.ts.">
          <div className="flex flex-wrap gap-2">
            {Object.keys(STATUS_LABELS).map((code) => (
              <StatusPill key={code} status={code} />
            ))}
          </div>
        </Card>

        <Card title="Tabs">
          <Tabs
            label="Pay app sections"
            tabs={[
              { id: "g702", label: "G702 summary", content: <p className="text-sm text-ink-muted">Summary content.</p> },
              { id: "g703", label: "G703 lines", content: <p className="text-sm text-ink-muted">Line items.</p> },
              { id: "history", label: "History", content: <p className="text-sm text-ink-muted">Version history.</p> },
            ]}
          />
        </Card>

        <Card title="Table" description="Sticky header, right-aligned money, cards below 640px.">
          <Table caption="Schedule of values" columns={COLUMNS} rows={LINES} rowKey={(r) => r.id} maxHeight="16rem" />
        </Card>

        <Card title="Form fields">
          <FormDemo />
        </Card>

        <Card title="Confirm dialog">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirmOpen(true)}>Approve &amp; pay</Button>
            <Button variant="danger" onClick={() => setDangerOpen(true)}>
              Close tranche (void remainder)
            </Button>
          </div>
          <p className="mt-3 text-xs text-ink-subtle" data-testid="confirm-log">
            Log: {log.length ? log.join(", ") : "none"}
          </p>
          <ConfirmDialog
            open={confirmOpen}
            title="Approve and pay: pay app #1"
            amountLabel="Net payout"
            amountCents={4124196}
            payee="Eastbay Electric (p***@eastbay.example)"
            details={[
              { label: "Gross approved", value: <Money cents={4341260} /> },
              { label: "Retainage withheld", value: <Money cents={217064} /> },
              { label: "Funding source", value: "Tranche T1 Rough-in" },
            ]}
            effect="Captures funds and sends a PayPal payout; can't be undone."
            confirmLabel="Approve & pay $41,241.96"
            onCancel={() => {
              setConfirmOpen(false);
              setLog((l) => [...l, "cancelled"]);
            }}
            onConfirm={async () => {
              await new Promise((r) => setTimeout(r, 600));
              setConfirmOpen(false);
              setLog((l) => [...l, "confirmed"]);
              toast.success("Payout sent to Eastbay Electric.");
            }}
          />
          <ConfirmDialog
            open={dangerOpen}
            tone="danger"
            title="Close tranche and void remainder"
            amountLabel="Voided remainder"
            amountCents={1587640}
            payee="PayPal authorization 8AB12345CD678901E"
            payeeLabel="Authorization"
            effect="Releases the remaining hold back to your payment method; it can't be captured later."
            acknowledgement="I understand this can't be undone."
            confirmLabel="Void $15,876.40"
            onCancel={() => {
              setDangerOpen(false);
              setLog((l) => [...l, "void cancelled"]);
            }}
            onConfirm={async () => {
              throw new Error("PayPal refused the void: AUTHORIZATION_ALREADY_CAPTURED.");
            }}
          />
        </Card>

        <Card title="Toasts">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => toast.success("Project settings saved")}>
              Success toast
            </Button>
            <Button variant="secondary" onClick={() => toast.error(new Error("California caps retainage at 5% for private works."))}>
              Error toast
            </Button>
          </div>
        </Card>

        <Card title="Empty state">
          <EmptyState
            icon={<FolderPlus className="h-8 w-8" />}
            title="No projects yet"
            description="Create your first project to set up the contract, retainage and billing schedule."
            action={<Button>Create your first project</Button>}
            headingLevel={3}
          />
        </Card>
      </div>
    </div>
  );
}

export default function UiKitGallery() {
  return (
    <ToastProvider>
      <main className="min-h-screen bg-surface-sunken font-sans text-ink">
        <GalleryBody />
      </main>
    </ToastProvider>
  );
}
