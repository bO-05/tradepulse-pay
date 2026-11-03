import { describe, expect, test } from "vitest";
import { resolveStoredFileUrl } from "./storedFile";

const SITE = "https://cheery-axolotl-689.convex.site";

describe("stored file URLs on a separate static host", () => {
  test("prefixes archive paths with the Convex site origin", () => {
    expect(resolveStoredFileUrl({ storageId: "/specs/23_00_00_HVAC_Systems_Spec.pdf" }, `${SITE}/`)).toBe(
      `${SITE}/specs/23_00_00_HVAC_Systems_Spec.pdf`,
    );
  });

  test("leaves absolute and Convex storage URLs alone", () => {
    expect(resolveStoredFileUrl({ storageId: `${SITE}/specs/x.pdf` }, SITE)).toBe(`${SITE}/specs/x.pdf`);
    expect(resolveStoredFileUrl({ url: "https://example.convex.cloud/blob" }, SITE)).toBe(
      "https://example.convex.cloud/blob",
    );
  });

  test("keeps the same-origin path when no site origin is supplied", () => {
    expect(resolveStoredFileUrl({ storageId: "/drawings/E-101.pdf" })).toBe("/drawings/E-101.pdf");
  });
});
