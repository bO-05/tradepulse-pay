import { describe, expect, test } from "vitest";
import { resolveRequestedProject } from "./requestedProject";

const camelback = { _id: "k97camelback" };
const demo = { _id: "k97demo", isDemoProject: true };

describe("procurement ?project= selection", () => {
  test("waits for the project list before deciding anything", () => {
    expect(resolveRequestedProject({ requestedId: "k97bayview", selectedId: "k97bayview", projects: undefined })).toEqual({
      kind: "loading",
    });
  });

  test("a foreign project id from the URL is Not found and never switches to another project", () => {
    expect(
      resolveRequestedProject({ requestedId: "k978yam8bayview", selectedId: "k978yam8bayview", projects: [camelback, demo] }),
    ).toEqual({ kind: "not-found" });
  });

  test("a missing id (deleted row or another table's id) resolves exactly like a foreign one", () => {
    const foreign = resolveRequestedProject({ requestedId: "k978yam8bayview", selectedId: "k978yam8bayview", projects: [camelback] });
    const missing = resolveRequestedProject({ requestedId: "jd7deletedrow", selectedId: "jd7deletedrow", projects: [camelback] });
    const otherTable = resolveRequestedProject({ requestedId: "ph7invite", selectedId: "ph7invite", projects: [camelback] });
    expect(missing).toEqual(foreign);
    expect(otherTable).toEqual(foreign);
  });

  test("a URL id with no accessible projects at all is still Not found, not the empty state", () => {
    expect(resolveRequestedProject({ requestedId: "k978yam8bayview", selectedId: "k978yam8bayview", projects: [] })).toEqual({
      kind: "not-found",
    });
  });

  test("an accessible URL id is confirmed", () => {
    expect(resolveRequestedProject({ requestedId: camelback._id, selectedId: camelback._id, projects: [camelback] })).toEqual({
      kind: "confirmed",
    });
  });

  test("a stale remembered selection (not from the URL) quietly falls back, preferring the Demo project", () => {
    expect(resolveRequestedProject({ requestedId: null, selectedId: "k97gone", projects: [camelback, demo] })).toEqual({
      kind: "fallback",
      projectId: demo._id,
    });
    expect(resolveRequestedProject({ requestedId: null, selectedId: "k97gone", projects: [camelback] })).toEqual({
      kind: "fallback",
      projectId: camelback._id,
    });
    expect(resolveRequestedProject({ requestedId: null, selectedId: camelback._id, projects: [camelback] })).toEqual({ kind: "keep" });
  });
});
