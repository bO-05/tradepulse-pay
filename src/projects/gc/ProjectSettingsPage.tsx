import { useMutation, useQuery } from "convex/react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { firstProjectSetupError } from "../../../convex/lib/projectSetup";
import { gcProjectHash, GC_PROJECTS_HASH } from "../../auth/navigation";
import { getErrorMessage } from "../../lib/errors";
import { Button, Card, ConfirmDialog, focusFirstInvalid, useToast } from "../../ui";
import { ArchivedBanner, ProjectHeader } from "./ProjectPage";
import { ProjectSetupFields } from "./ProjectSetupFields";
import {
  formStateFromProject,
  serverFieldError,
  toProjectArgs,
  validateForm,
  visibleErrors,
  type ProjectSetupFormState,
} from "./projectSetupForm";

/** Project settings (architecture §14): GC of the owning company edits setup fields, archives or restores. */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const project = useQuery(api.projects.getProject, { projectId });
  const companyData = useQuery(api.companies.myCompany, {});
  if (project === undefined || companyData === undefined) {
    return <p role="status" className="text-sm text-ink-subtle">Loading project settings…</p>;
  }
  const archived = project.archived === true;
  return (
    <div className="max-w-3xl space-y-5">
      <ProjectHeader
        project={project}
        actions={
          <a
            href={gcProjectHash(project._id)}
            className="inline-flex min-h-touch items-center rounded-lg border border-line-strong px-4 text-sm font-semibold text-ink hover:bg-surface-raised"
          >
            Back to project
          </a>
        }
      />
      <h2 className="text-lg font-semibold">Project settings</h2>
      {archived && <ArchivedBanner projectId={project._id} />}
      <SettingsForm key={project._id} project={project} companyDefaultBps={companyData.company.defaultRetainageBps} readOnly={archived} />
      {!archived && <ArchiveCard project={project} />}
    </div>
  );
}

function SettingsForm({
  project,
  companyDefaultBps,
  readOnly,
}: {
  project: Doc<"projects">;
  companyDefaultBps: number;
  readOnly: boolean;
}) {
  const update = useMutation(api.projects.updateProject);
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<ProjectSetupFormState>(() => formStateFromProject(project));
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<{ field?: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  // Follow live changes (for example a restore or another tab's save) while the user has no unsaved edits.
  useEffect(() => {
    if (!dirty) setForm(formStateFromProject(project));
  }, [project, dirty]);

  const errors = validateForm(form, companyDefaultBps);
  const shown = { ...visibleErrors(errors, submitted) };
  if (serverError?.field && !(serverError.field in shown)) (shown as Record<string, string>)[serverError.field] = serverError.message;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || readOnly) return;
    setSubmitted(true);
    setServerError(null);
    if (firstProjectSetupError(errors)) {
      focusFirstInvalid(formRef.current);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      await update({ projectId: project._id, ...toProjectArgs(form, companyDefaultBps) });
      toast.success("Project settings saved.");
      setDirty(false);
      setSubmitted(false);
    } catch (err) {
      const field = serverFieldError(err);
      setServerError(field ?? { message: getErrorMessage(err, "We couldn't save the project settings. Try again.") });
      focusFirstInvalid(formRef.current);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Card title="Project details" description={readOnly ? "Restore the project to edit these settings." : "Fields marked * are required."}>
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="Project settings" className="space-y-5">
        <ProjectSetupFields
          form={form}
          onChange={(patch) => {
            setServerError(null);
            setDirty(true);
            setForm((prev) => ({ ...prev, ...patch }));
          }}
          errors={shown}
          companyDefaultBps={companyDefaultBps}
          idPrefix="project-settings"
          disabled={saving || readOnly}
        />
        {serverError && !serverError.field && (
          <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {serverError.message}
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={saving} loadingLabel="Saving…">
              Save settings
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setForm(formStateFromProject(project));
                  setDirty(false);
                  setSubmitted(false);
                  setServerError(null);
                }}
              >
                Discard changes
              </Button>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

function ArchiveCard({ project }: { project: Doc<"projects"> }) {
  const archive = useMutation(api.projects.archiveProject);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <Card title="Archive project" description="Archiving hides the project from lists and makes it read-only. Nothing is deleted, and you can restore it any time.">
      <Button variant="danger" onClick={() => setOpen(true)}>
        Archive project
      </Button>
      <ConfirmDialog
        open={open}
        title={`Archive "${project.title}"?`}
        effect="The project disappears from the project list and the project switcher, and becomes read-only. Its data is kept. Use “Show archived” on All projects to find and restore it."
        confirmLabel="Archive project"
        tone="danger"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          await archive({ projectId: project._id });
          setOpen(false);
          toast.success(`"${project.title}" archived.`);
          window.location.hash = GC_PROJECTS_HASH;
        }}
      />
    </Card>
  );
}
