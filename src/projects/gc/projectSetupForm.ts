import {
  parseBillingDay,
  validateProjectSetup,
  type ProjectSetupErrors,
  type ProjectSetupField,
} from "../../../convex/lib/projectSetup";
import { checkRetainage, defaultRetainage, formatRetainagePercent, retainageRuleFor } from "../../../convex/lib/retainageRules";

/** Editable state of the New project wizard / Project settings form. Money in cents, retainage in bps. */
export type ProjectSetupFormState = {
  title: string;
  ownerName: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  contractValueCents: number | null;
  retainageBps: number | null;
  /** False while the retainage field still follows the company default / state cap. */
  retainageTouched: boolean;
  billingDay: string;
  startDate: string;
  substantialCompletionDate: string;
};

export const EMPTY_PROJECT_SETUP: ProjectSetupFormState = {
  title: "",
  ownerName: "",
  line1: "",
  city: "",
  state: "",
  zip: "",
  contractValueCents: null,
  retainageBps: null,
  retainageTouched: false,
  billingDay: "",
  startDate: "",
  substantialCompletionDate: "",
};

type StoredProject = {
  title: string;
  ownerName?: string;
  address?: { line1: string; city: string; state: string; zip: string };
  state?: string;
  contractValueCents?: number;
  retainageBps?: number;
  billingDay?: number;
  startDate?: string;
  substantialCompletionDate?: string;
};

export function formStateFromProject(p: StoredProject): ProjectSetupFormState {
  return {
    title: p.title,
    ownerName: p.ownerName ?? "",
    line1: p.address?.line1 ?? "",
    city: p.address?.city ?? "",
    state: p.state ?? p.address?.state ?? "",
    zip: p.address?.zip ?? "",
    contractValueCents: p.contractValueCents ?? null,
    retainageBps: p.retainageBps ?? null,
    retainageTouched: p.retainageBps !== undefined,
    billingDay: p.billingDay !== undefined ? String(p.billingDay) : "",
    startDate: p.startDate ?? "",
    substantialCompletionDate: p.substantialCompletionDate ?? "",
  };
}

/** The retainage the form uses: the typed value, or the default while the field is untouched. */
export function effectiveRetainageBps(form: ProjectSetupFormState, companyDefaultBps: number | null | undefined): number | null {
  if (form.retainageTouched) return form.retainageBps;
  return defaultRetainage(companyDefaultBps, form.state || null, form.contractValueCents).bps;
}

export function validateForm(form: ProjectSetupFormState, companyDefaultBps: number | null | undefined): ProjectSetupErrors {
  return validateProjectSetup({
    title: form.title,
    ownerName: form.ownerName,
    address: { line1: form.line1, city: form.city, zip: form.zip },
    state: form.state,
    contractValueCents: form.contractValueCents,
    retainageBps: effectiveRetainageBps(form, companyDefaultBps),
    billingDay: parseBillingDay(form.billingDay),
    startDate: form.startDate,
    substantialCompletionDate: form.substantialCompletionDate,
  });
}

/** Mutation arguments; call only after validateForm returned no errors. */
export function toProjectArgs(form: ProjectSetupFormState, companyDefaultBps: number | null | undefined) {
  const state = form.state.trim().toUpperCase();
  return {
    title: form.title.trim(),
    ownerName: form.ownerName.trim(),
    address: { line1: form.line1.trim(), city: form.city.trim(), state, zip: form.zip.trim() },
    state,
    contractValueCents: form.contractValueCents ?? 0,
    retainageBps: effectiveRetainageBps(form, companyDefaultBps) ?? 0,
    billingDay: parseBillingDay(form.billingDay) ?? 0,
    startDate: form.startDate,
    ...(form.substantialCompletionDate ? { substantialCompletionDate: form.substantialCompletionDate } : {}),
  };
}

/** Hint under the retainage field: where the default came from and the state's rule. */
export function retainageHint(form: ProjectSetupFormState, companyDefaultBps: number | null | undefined): string | null {
  const parts: string[] = [];
  if (!form.retainageTouched) {
    const d = defaultRetainage(companyDefaultBps, form.state || null, form.contractValueCents);
    const rule = retainageRuleFor(form.state);
    parts.push(
      d.loweredToCap && rule
        ? `Lowered from your company default of ${formatRetainagePercent(d.companyDefaultBps)} to the ${rule.stateName} cap of ${formatRetainagePercent(d.bps)}.`
        : `Your company default (${formatRetainagePercent(d.companyDefaultBps)}).`,
    );
  }
  const bps = effectiveRetainageBps(form, companyDefaultBps);
  if (form.state && bps !== null) {
    const check = checkRetainage(form.state, form.contractValueCents, bps);
    if (check.ok && check.note) parts.push(check.note);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Errors to show now: everything after a submit attempt, and a retainage cap block as soon as it applies. */
export function visibleErrors(errors: ProjectSetupErrors, submitted: boolean): ProjectSetupErrors {
  if (submitted) return errors;
  const live: ProjectSetupErrors = {};
  if (errors.retainageBps && /caps retainage/.test(errors.retainageBps)) live.retainageBps = errors.retainageBps;
  return live;
}

export type ServerFieldError = { field: ProjectSetupField; message: string } | null;

export function serverFieldError(err: unknown): ServerFieldError {
  const data = (err as { data?: { field?: unknown; message?: unknown } }).data;
  if (data && typeof data.field === "string" && typeof data.message === "string") {
    return { field: data.field as ProjectSetupField, message: data.message };
  }
  return null;
}
