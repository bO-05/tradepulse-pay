import { ConvexError } from "convex/values";

export const REFERENCE_RUN_ID = "nx74k1sdcnsmqzvkr97kf0ts598hch6p";
export const REFERENCE_AGREEMENT_ID = "jn78x0j5xeh7q9gb55p26r7pdh8hdmjx";
export const READ_ONLY_REFERENCE_MESSAGE =
  "This is a preserved, read-only demo fixture. Start a fresh guided run to try approvals and sandbox payments.";

export function isReadOnlyReference(project: { readOnlyReference?: boolean; readOnlyDemoFixture?: boolean } | null): boolean {
  return project?.readOnlyReference === true || project?.readOnlyDemoFixture === true;
}

export function assertReferenceWritable(project: { readOnlyReference?: boolean; readOnlyDemoFixture?: boolean }): void {
  if (isReadOnlyReference(project)) {
    throw new ConvexError({ code: "READ_ONLY_REFERENCE", message: READ_ONLY_REFERENCE_MESSAGE });
  }
}

export function assertDemoSettingsWritable(company: { demoReadOnly?: boolean }): void {
  if (company.demoReadOnly) throw new ConvexError({
    code: "DEMO_READ_ONLY",
    message: "Shared demo identity, recipient and directory settings are read-only. Use a fresh guided run for sandbox workflows.",
  });
}
