import { useMutation, useQuery } from "convex/react";
import { FormEvent, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { firstProjectSetupError } from "../../../convex/lib/projectSetup";
import { GC_PROJECTS_HASH, gcProjectHash } from "../../auth/navigation";
import { getErrorMessage } from "../../lib/errors";
import { Button, Card, PageHeader, focusFirstInvalid, useToast } from "../../ui";
import { ProjectSetupFields } from "./ProjectSetupFields";
import {
  EMPTY_PROJECT_SETUP,
  serverFieldError,
  toProjectArgs,
  validateForm,
  visibleErrors,
  type ProjectSetupFormState,
} from "./projectSetupForm";
import { AddTradePackageForm, TradePackagesSection } from "./TradePackagesSection";
import { openSpecBreakdown } from "./specBreakdownRequest";

/** New project wizard (architecture §14): step 1 project details, step 2 trade packages. */
export function NewProjectWizard() {
  const companyData = useQuery(api.companies.myCompany, {});
  const [created, setCreated] = useState<{ id: Id<"projects">; title: string } | null>(null);

  if (companyData === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading…</p>;
  const companyDefaultBps = companyData.company.defaultRetainageBps;

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="New project"
        description={created ? "Step 2 of 2: Trade packages" : "Step 1 of 2: Project details"}
        back={{ href: GC_PROJECTS_HASH, label: "All projects" }}
      />
      {created ? (
        <PackagesStep projectId={created.id} projectTitle={created.title} />
      ) : (
        <DetailsStep companyDefaultBps={companyDefaultBps} onCreated={setCreated} />
      )}
    </div>
  );
}

function DetailsStep({
  companyDefaultBps,
  onCreated,
}: {
  companyDefaultBps: number;
  onCreated: (p: { id: Id<"projects">; title: string }) => void;
}) {
  const create = useMutation(api.projects.createProject);
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<ProjectSetupFormState>(EMPTY_PROJECT_SETUP);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<{ field?: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const errors = validateForm(form, companyDefaultBps);
  const shown = { ...visibleErrors(errors, submitted) };
  if (serverError?.field && !(serverError.field in shown)) (shown as Record<string, string>)[serverError.field] = serverError.message;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    setSubmitted(true);
    setServerError(null);
    if (firstProjectSetupError(errors)) {
      focusFirstInvalid(formRef.current);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const args = toProjectArgs(form, companyDefaultBps);
      const id = (await create(args)) as Id<"projects">;
      toast.success(`Project "${args.title}" created.`);
      onCreated({ id, title: args.title });
    } catch (err) {
      const field = serverFieldError(err);
      setServerError(field ?? { message: getErrorMessage(err, "We couldn't create the project. Try again.") });
      focusFirstInvalid(formRef.current);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Card title="Project details" description="Fields marked * are required.">
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="New project" className="space-y-5">
        <ProjectSetupFields
          form={form}
          onChange={(patch) => {
            setServerError(null);
            setForm((prev) => ({ ...prev, ...patch }));
          }}
          errors={shown}
          companyDefaultBps={companyDefaultBps}
          idPrefix="new-project"
          disabled={saving}
        />
        {serverError && !serverError.field && (
          <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {serverError.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={saving} loadingLabel="Creating…">
            Create project and continue
          </Button>
          <a href={GC_PROJECTS_HASH} className="inline-flex items-center rounded-lg px-3 text-sm text-ink-subtle hover:text-ink">
            Cancel
          </a>
        </div>
      </form>
    </Card>
  );
}

function PackagesStep({ projectId, projectTitle }: { projectId: Id<"projects">; projectTitle: string }) {
  const [mode, setMode] = useState<"choose" | "manual">("choose");
  return (
    <div className="space-y-5">
      <Card
        title="Add trade packages"
        description={`"${projectTitle}" is created. Break the work into trade packages now, or skip and add them later from the project page.`}
      >
        {mode === "manual" ? (
          <AddTradePackageForm projectId={projectId} projectTitle={projectTitle} onCancel={() => setMode("choose")} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setMode("manual")}>Add a package manually</Button>
            <Button variant="secondary" onClick={() => openSpecBreakdown(projectId)}>
              AI spec breakdown
            </Button>
          </div>
        )}
      </Card>
      <TradePackagesSection projectId={projectId} projectTitle={projectTitle} />
      <div className="flex flex-wrap gap-2">
        <a href={gcProjectHash(projectId)} className="inline-flex min-h-touch items-center rounded-lg border border-line-strong px-4 text-sm font-semibold hover:bg-surface-raised">
          Finish
        </a>
        <a href={gcProjectHash(projectId)} className="inline-flex min-h-touch items-center rounded-lg px-4 text-sm text-ink-subtle hover:text-ink">
          Skip for now
        </a>
      </div>
    </div>
  );
}
