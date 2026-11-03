import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { BUILD_COMMIT, BUILD_COMMIT_SHORT } from "../lib/buildInfo";
import { BuildStamp } from "./BuildStamp";

describe("build stamp", () => {
  test("shows the commit and links to the machine-readable version file", () => {
    const html = renderToStaticMarkup(<BuildStamp />);
    expect(html).toContain('data-testid="build-stamp"');
    expect(html).toContain(BUILD_COMMIT_SHORT);
    expect(html).toContain('href="/version.json"');
    expect(BUILD_COMMIT.length).toBeGreaterThanOrEqual(3);
  });
});
