// #40 task 4 — the "no workspaces assigned" dead end.
//
// This site is NOT a pure capability swap. The condition is `!workspace &&
// <cannot create>`: a user with no workspace who *can* create one is not
// stranded, they simply have not made one yet, and showing them the dead-end
// screen hides the button that would fix it. So `!workspace` stays and only the
// role half moves.

import { readFileSync } from "fs";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockCapabilities = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
}));
const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));
const mockWorkspace = vi.hoisted(() => ({ current: null }));

vi.mock("@/models/system", () => ({
  default: { fetchMyCapabilities: async () => mockCapabilities.current },
}));
vi.mock("@/hooks/useUser", () => ({
  default: () => ({ user: mockUser.current }),
}));

import useCapabilities, { resetCapabilities } from "@/hooks/useCapabilities";

// The gate in isolation. Home itself pulls in the whole chat surface, so
// rendering it here would test twenty other things and fail for reasons that
// have nothing to do with authorization.
function DeadEndGate() {
  const { can, loading } = useCapabilities();
  const user = mockUser.current;
  const workspace = mockWorkspace.current;
  if (!workspace && user && (loading || !can("workspace.create")))
    return <div>no-workspaces-assigned</div>;
  return <div>workspace-surface</div>;
}

const deadEnd = () => screen.queryByText("no-workspaces-assigned");
const surface = () => screen.queryByText("workspace-surface");

const HOLDS_CREATE_ONLY = {
  "settings.write": false,
  "workspace.create": true,
};
const HOLDS_SETTINGS_ONLY = {
  "settings.write": true,
  "workspace.create": false,
};

function renderGate({ capabilities, user, workspace = null }) {
  mockCapabilities.current = { capabilities, workspace: null, error: null };
  mockUser.current = user;
  mockWorkspace.current = workspace;
  return render(<DeadEndGate />);
}

beforeEach(() => resetCapabilities());
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: Home's dead-end screen asks whether you can create", () => {
  test("the transcribed gate still matches the one in Home", () => {
    // DeadEndGate above is a transcription: rendering Home itself would pull in
    // the entire chat surface and fail for twenty unrelated reasons. That makes
    // every assertion below conditional on the transcription staying true --
    // the failure mode of #115, where a test drove a local helper and the
    // production path went unguarded. This is the guard: if Home's condition
    // changes, these tests stop describing it and say so here.
    // vitest gives __dirname in this environment; import.meta.url is not a
    // file: URL here.
    const source = readFileSync(`${__dirname}/index.jsx`, "utf8");
    expect(source).toContain(
      'if (!workspace && user && (loading || !can("workspace.create")))'
    );
  });

  test("a default-roled user holding workspace.create is not sent to the dead end", async () => {
    // The bug: `role === "default"` showed this screen to a user who can create
    // a workspace, hiding the control that would resolve it.
    renderGate({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(surface()).toBeInTheDocument());
    expect(deadEnd()).toBeNull();
  });

  test("a user who cannot create and has no workspace sees the dead end", async () => {
    renderGate({
      capabilities: HOLDS_SETTINGS_ONLY,
      user: { id: 1, role: "admin" },
    });
    await waitFor(() => expect(deadEnd()).toBeInTheDocument());
  });

  test("having a workspace never shows the dead end, whatever the capability", async () => {
    // `!workspace` is load-bearing on its own: a user who cannot create but
    // already has a workspace must reach it.
    renderGate({
      capabilities: HOLDS_SETTINGS_ONLY,
      user: { id: 1, role: "default" },
      workspace: { id: 7, slug: "existing" },
    });
    await waitFor(() => expect(surface()).toBeInTheDocument());
    expect(deadEnd()).toBeNull();
  });

  test("single-user mode never sees the dead end", async () => {
    renderGate({ capabilities: {}, user: null });
    await waitFor(() => expect(surface()).toBeInTheDocument());
  });
});
