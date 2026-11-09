import { describe, expect, test } from "vitest";
import { maskSandboxEmail, maskSharedEmail, publicContactEmail } from "./demoPrivacy";

describe("shared demo addresses are masked on screen", () => {
  test("maskSharedEmail hides a sandbox alias local part", () => {
    expect(maskSharedEmail("owner-q97f6pmh2d5qn733jmh5pg4c3x8hr9sn@example.com")).toBe("[demo inbox]@example.com");
  });

  test("maskSharedEmail hides a demo account local part", () => {
    expect(maskSharedEmail("owner@demo.tradepulse")).toBe("[demo inbox]@demo.tradepulse");
  });

  test("maskSharedEmail leaves a real customer address intact", () => {
    expect(maskSharedEmail("dana@bayview.example.org")).toBe("dana@bayview.example.org");
  });

  test("maskSharedEmail handles missing values", () => {
    expect(maskSharedEmail(null)).toBeNull();
    expect(maskSharedEmail(undefined)).toBeNull();
    expect(maskSharedEmail("not-an-address")).toBe("Demo inbox");
  });
});

describe("payout receipts keep the address recognizable but never the full alias", () => {
  test("maskSandboxEmail masks a sandbox personal alias", () => {
    expect(maskSandboxEmail("sb-ll43ii53793068@personal.example.com")).toBe("sb-****@personal.example.com");
    expect(maskSandboxEmail("sb-xlbzd53206872@business.example.com")).toBe("sb-****@business.example.com");
  });

  test("maskSandboxEmail falls back to the shared-address mask and leaves real addresses", () => {
    expect(maskSandboxEmail("owner@demo.tradepulse")).toBe("[demo inbox]@demo.tradepulse");
    expect(maskSandboxEmail("dana@bayview.example.org")).toBe("dana@bayview.example.org");
    expect(maskSandboxEmail(null)).toBeNull();
  });

  test("publicContactEmail hides the quote-intake placeholder", () => {
    expect(publicContactEmail("not-published@verify-required.invalid")).toBe("Contact not published");
    expect(publicContactEmail("ap@harborpoint.test")).toBe("ap@harborpoint.test");
  });
});
