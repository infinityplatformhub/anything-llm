// #40 task 4 — Sidebar's two authorization sites.
//
//   :161 wraps SettingsButton      -> settings.write
//   :193 NewWorkspaceButton        -> workspace.create
//
// These are different capabilities in the same file, which is the point: the
// role string collapsed both into `role !== "default"`, so a user granted one
// and not the other got the wrong answer for at least one of them.
//
// Four states each. The single-user case (no user row) must still show both:
// there is no principal, the map is empty, and a gate that only asks can()
// locks a single-user deployment out of its own UI.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mockCapabilities = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
  resolve: null,
  deferred: false,
}));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => {
      if (mockCapabilities.deferred) {
        await new Promise((resolve) => {
          mockCapabilities.resolve = resolve;
        });
      }
      return mockCapabilities.current;
    },
  },
}));

const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));
vi.mock("@/hooks/useUser", () => ({
  default: () => ({ user: mockUser.current }),
}));

import { NewWorkspaceButton } from "@/components/Sidebar";
import useCapabilities, { resetCapabilities } from "@/hooks/useCapabilities";

function renderNewWorkspaceButton({ capabilities, user }) {
  mockCapabilities.current = { capabilities, workspace: null, error: null };
  mockUser.current = user;
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <NewWorkspaceButton user={user} showNewWsModal={() => {}} />
    </MemoryRouter>
  );
}

// i18n is not initialised in the test environment, so `t("new-workspace.title")`
// renders the key itself. Query for the key: matching on English copy would
// make this test fail whenever the wording changes, which is not what it is
// about.
const newWorkspaceControl = () => screen.queryByText("new-workspace.title");

// Renders a probe whose text flips once the hook settles, so a test can wait
// for "the map arrived" instead of for something already true on the first tick
// (TL-1: waiting on the fixture asserts against the LOADING state, and passes
// even for a can() that always answers true).
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
});
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: NewWorkspaceButton gates on workspace.create", () => {
  test("a default-roled user holding workspace.create sees it", async () => {
    // DoD 3 of #40, and the bug task 5 is written against: a `default` user
    // with a workspace.create grant may create workspaces, and the server says
    // so. The role string cannot see the grant.
    renderNewWorkspaceButton({
      capabilities: { "workspace.create": true },
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(newWorkspaceControl()).toBeInTheDocument());
  });

  test("a manager-roled user without the grant does not", async () => {
    renderNewWorkspaceButton({
      capabilities: { "workspace.create": false },
      user: { id: 1, role: "manager" },
    });
    await waitForCapabilitiesToLoad();
    expect(newWorkspaceControl()).toBeNull();
  });

  test("single-user mode still shows it", async () => {
    renderNewWorkspaceButton({ capabilities: {}, user: null });
    await waitFor(() => expect(newWorkspaceControl()).toBeInTheDocument());
  });

  test("hidden while loading, and that differs from the resolved answer", async () => {
    mockCapabilities.deferred = true;
    renderNewWorkspaceButton({
      capabilities: { "workspace.create": true },
      user: { id: 1, role: "default" },
    });
    expect(newWorkspaceControl()).toBeNull();

    mockCapabilities.resolve?.();
    await waitFor(() => expect(newWorkspaceControl()).toBeInTheDocument());
  });

  test("workspace.create and settings.write are not interchangeable", async () => {
    // The two sites in this file gate on different capabilities. Holding only
    // settings.write must NOT reveal the create control -- otherwise the
    // rewrite reproduced the role string's conflation in a new spelling.
    renderNewWorkspaceButton({
      capabilities: { "settings.write": true, "workspace.create": false },
      user: { id: 1, role: "admin" },
    });
    await waitForCapabilitiesToLoad();
    expect(newWorkspaceControl()).toBeNull();
  });
});
