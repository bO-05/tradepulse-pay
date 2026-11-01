import { v, type Infer } from "convex/values";

/** Compliance record validators (architecture §17), shared by the schema and the public functions. */

export const complianceKindValidator = v.union(v.literal("coi"), v.literal("w9"), v.literal("license"));
export type ComplianceKind = Infer<typeof complianceKindValidator>;

export const complianceReviewStatusValidator = v.union(
  v.literal("pending_review"),
  v.literal("accepted"),
  v.literal("rejected"),
);

export const w9EntityTypeValidator = v.union(
  v.literal("individual"),
  v.literal("c_corporation"),
  v.literal("s_corporation"),
  v.literal("partnership"),
  v.literal("trust_estate"),
  v.literal("llc_c"),
  v.literal("llc_s"),
  v.literal("llc_p"),
  v.literal("other"),
);
export type W9EntityType = Infer<typeof w9EntityTypeValidator>;

/** "cslb_live": a KERNEL CSLB lookup returned a result; "unverified": CA license not (successfully) looked up; "manual": non-CA. */
export const licenseVerificationValidator = v.union(v.literal("cslb_live"), v.literal("manual"), v.literal("unverified"));

export const coiFieldsValidator = v.object({
  insurer: v.string(),
  glPolicyNumber: v.string(),
  autoPolicyNumber: v.optional(v.string()),
  umbrellaPolicyNumber: v.optional(v.string()),
  wcPolicyNumber: v.optional(v.string()),
  glEachOccurrenceCents: v.number(),
  glAggregateCents: v.number(),
  autoCents: v.number(),
  umbrellaCents: v.number(),
  workersComp: v.boolean(),
  additionalInsured: v.boolean(),
  effectiveDate: v.string(), // YYYY-MM-DD
  expiryDate: v.string(), // YYYY-MM-DD
});
export type CoiFields = Infer<typeof coiFieldsValidator>;

/** Only the last four TIN digits ever reach the server; the full number stays in the browser. */
export const w9FieldsValidator = v.object({
  entityType: w9EntityTypeValidator,
  tinLast4: v.string(),
  signedDate: v.string(), // YYYY-MM-DD
});
export type W9Fields = Infer<typeof w9FieldsValidator>;

export const licenseInputValidator = v.object({
  licenseNumber: v.string(),
  state: v.string(),
  classification: v.string(),
  expiryDate: v.string(), // YYYY-MM-DD
});
export type LicenseInput = Infer<typeof licenseInputValidator>;

export const licenseFieldsValidator = v.object({
  licenseNumber: v.string(),
  state: v.string(),
  classification: v.string(),
  expiryDate: v.string(),
  verification: licenseVerificationValidator,
});

export const complianceInputValidator = v.union(
  v.object({ kind: v.literal("coi"), coi: coiFieldsValidator }),
  v.object({ kind: v.literal("w9"), w9: w9FieldsValidator }),
  v.object({ kind: v.literal("license"), license: licenseInputValidator }),
);
export type ComplianceInput = Infer<typeof complianceInputValidator>;
