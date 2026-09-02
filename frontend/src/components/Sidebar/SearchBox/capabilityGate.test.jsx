// #40 task 4 — the narrow-width New Workspace control.
//
// Same affordance as Sidebar's NewWorkspaceButton, rendered when the sidebar is
// collapsed. It must ask the same capability: two spellings of one affordance
// that disagree is worse than either being wrong on its own, because which
// answer a user gets then depends on their window width.
//
// RF-2 (TL-1): every fixture carries BOTH capabilities with different values.
// A fixture holding only the capability under test goes green under any
// mapping, including a wrong one.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mockCapabilities = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
  resolve: null,
  deferred: false,
  rejects: false,
}));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => {
      if (mockCapabilities.deferred) {
        await new Promise((resolve) => {
          mockCapabilities.resolve = resolve;
        });
      }
      if (mockCapabilities.rejects) throw new Error("network");
      return mockCapabilities.current;
    },
  },
}));

vi.mock("@/models/workspace", () => ({
  default: { searchWorkspaces: async () => ({ results: [] }) },
}));

import { ShortWidthNewWorkspaceButton } from "@/components/Sidebar/SearchBox";
import useCapabilities, { resetCapabilities } from "@/hooks/useCapabilities";

function renderControl({ capabilities, user }) {
  mockCapabilities.current = { capabilities, workspace: null, error: null };
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ShortWidthNewWorkspaceButton user={user} showNewWsModal={() => {}} />
    </MemoryRouter>
  );
}

// The collapsed control is icon-only: its label lives in data-tooltip-content,
// not in text. Querying by text would find nothing whether the gate showed it
// or not -- a test that can only ever pass its negative assertions.
const control = () =>
  document.querySelector('[data-tooltip-content="new-workspace.title"]');

// A principal that holds settings.write and NOT workspace.create. The role
// string could not express this at all -- it is the case the whole rewrite
// exists for, and the one that catches a swapped capability.
const HOLDS_SETTINGS_ONLY = {
  "settings.write": true,
  "workspace.create": false,
};
const HOLDS_CREATE_ONLY = {
  "settings.write": false,
  "workspace.create": true,
};

// Renders a probe whose text changes when the hook settles, so a test can wait
// for "the map arrived" rather than for something that was already true.
function CapabilityProbe() {
  const { loading } = useCapabilities();
  return <span>{loading ? "caps-loading" : "caps-ready"}</span>;
}

async function waitForCapabilitiesToLoad() {
  render(<CapabilityProbe />);
  await screen.findByText("caps-ready");
}

beforeEach(() => {
  resetCapabilities();
  mockCapabilities.deferred = false;
  mockCapabilities.resolve = null;
  mockCapabilities.rejects = false;
});
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: the collapsed-sidebar create control", () => {
  test("shown to a default-roled user holding only workspace.create", async () => {
    renderControl({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(control()).toBeInTheDocument());
  });

  test("hidden from an admin-roled user holding only settings.write", async () => {
    // Both halves matter: the role says admin (the old check would show it) and
    // the caller holds a capability (so this is not an empty-map pass).
    //
    // The wait must observe the map ARRIVING, not merely that the fixture
    // exists — the fixture is defined on the first tick, so waiting on it
    // asserts against the loading state and would pass even for a can() that
    // always answers true (TL-1). Rendering a probe that flips only once the
    // map has resolved is what makes the wait mean something.
    renderControl({
      capabilities: HOLDS_SETTINGS_ONLY,
      user: { id: 1, role: "admin" },
    });
    await waitForCapabilitiesToLoad();
    expect(control()).toBeNull();
  });

  test("single-user mode still shows it", async () => {
    renderControl({ capabilities: {}, user: null });
    await waitFor(() => expect(control()).toBeInTheDocument());
  });

  test("hidden while loading, and that differs from the resolved answer", async () => {
    mockCapabilities.deferred = true;
    renderControl({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 1, role: "default" },
    });
    expect(control()).toBeNull();

    mockCapabilities.resolve?.();
    await waitFor(() => expect(control()).toBeInTheDocument());
  });

  test("a failed fetch settles hidden rather than loading forever", async () => {
    // RF-3 (TL-1): a rejection must end the loading state. A control stuck in
    // loading renders identically to a denied one, so the bug would be
    // invisible -- and every later mount in the tab inherits it.
    mockCapabilities.rejects = true;
    renderControl({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(control()).toBeNull());

    // And the rejection is not cached: the next reader retries and succeeds.
    resetCapabilities();
    mockCapabilities.rejects = false;
    renderControl({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 2, role: "default" },
    });
    await waitFor(() => expect(control()).toBeInTheDocument());
  });
});
