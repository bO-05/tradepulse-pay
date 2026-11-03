/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { studioCorsHeaders } from "./dashboard/studioProxy";
import { inviteLink } from "./lib/inviteRules";
import { browserOrigins } from "./lib/browserOrigins";
import { corsHeaders } from "./projectFileDownload";

const CANONICAL = "https://tradepulse-pay.asynchronope.tech";
const MIRROR = "https://cheery-axolotl-689.convex.site";
const LOCAL = "http://localhost:3150";

afterEach(() => {
  vi.unstubAllEnvs();
});

function originRequest(origin: string): Request {
  return new Request("https://cheery-axolotl-689.convex.site/api/project-files/x", {
    method: "GET",
    headers: { Origin: origin },
  });
}

describe("frontend origins during the dual-host window", () => {
  test("allows the canonical domain, the convex.site mirror and local Vite", () => {
    vi.stubEnv("SITE_URL", CANONICAL);
    vi.stubEnv("CONVEX_SITE_URL", MIRROR);
    expect(browserOrigins()).toEqual([CANONICAL, MIRROR, LOCAL]);
    for (const origin of [CANONICAL, MIRROR, LOCAL]) {
      expect(corsHeaders(originRequest(origin))["Access-Control-Allow-Origin"], origin).toBe(origin);
      expect(studioCorsHeaders(originRequest(origin))["Access-Control-Allow-Origin"], origin).toBe(origin);
    }
    expect(corsHeaders(originRequest("https://evil.example.test"))).toEqual({});
    expect(studioCorsHeaders(originRequest("https://evil.example.test"))).toEqual({});
  });

  test("normalizes a trailing slash and never duplicates an origin", () => {
    vi.stubEnv("SITE_URL", `${CANONICAL}/`);
    vi.stubEnv("CONVEX_SITE_URL", CANONICAL);
    expect(browserOrigins()).toEqual([CANONICAL, LOCAL]);
  });

  test("invite links follow SITE_URL so new invites open on the canonical domain", () => {
    const token = "A".repeat(43);
    expect(inviteLink(CANONICAL, token)).toBe(`${CANONICAL}/#/invite/${token}`);
  });
});
