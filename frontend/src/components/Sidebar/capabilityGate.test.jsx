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

// The full-Sidebar block below renders the real component, which pulls in the
// logo context, the workspace list and the footer. Those are stubbed because
// this file is about the two authorization sites; leaving them real would make
// the tests fail for reasons that have nothing to do with capabilities.
vi.mock("@/hooks/useLogo", () => ({
  default: () => ({ logo: "logo.png", setLogo: () => {} }),
}));
vi.mock("@/components/Sidebar/ActiveWorkspaces", () => ({
  default: () => <div>active-workspaces</div>,
}));
vi.mock("@/components/Footer", () => ({
  default: () => <div>footer</div>,
}));
vi.mock("@/models/workspace", () => ({
  default: {
    all: async () => [],
    searchWorkspaces: async () => ({ results: [] }),
  },
}));

import { NewWorkspaceButton, SidebarMobileHeader } from "@/components/Sidebar";
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

  test("holding settings.write does not reveal the create control", async () => {
    // Renamed after QA-3 M4: the old name claimed the two SITES were not
    // interchangeable, but this only ever rendered NewWorkspaceButton -- it
    // said nothing about :166, which was never exercised at all. The claim now
    // matches what is asserted, and the site-level version is below.
    renderNewWorkspaceButton({
      capabilities: { "settings.write": true, "workspace.create": false },
      user: { id: 1, role: "admin" },
    });
    await waitForCapabilitiesToLoad();
    expect(newWorkspaceControl()).toBeNull();
  });
});

describe("#40 task 4 M4: SidebarMobileHeader, so :166 is actually exercised", () => {
  // QA-3 M4. Every test above renders NewWorkspaceButton directly, so the
  // SettingsButton wrapper had no coverage -- reverting it to the role string
  // left the suite green.
  //
  // The wrapper lives in SidebarMobileHeader, NOT in the default Sidebar
  // export: rendering `<Sidebar />` never reaches it, which is why the first
  // attempt at this test still proved nothing about the site.
  function renderSidebar({ capabilities, user }) {
    mockCapabilities.current = { capabilities, workspace: null, error: null };
    mockUser.current = user;
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarMobileHeader />
      </MemoryRouter>
    );
  }

  // SettingsButton renders a "Settings" cog outside /settings/* and a "Home"
  // arrow within it, so matching only /settings/i finds nothing on the home
  // route and every negative assertion would pass for free.
  const settingsControl = () =>
    screen.queryByLabelText("Settings") ?? screen.queryByLabelText("Home");

  test("a principal holding workspace.create but NOT settings.write gets the create control and no settings", async () => {
    // The fixture the role string could not express: one capability held, the
    // other not. `role !== "default"` showed both or neither.
    renderSidebar({
      capabilities: { "workspace.create": true, "settings.write": false },
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(newWorkspaceControl()).toBeInTheDocument());
    expect(settingsControl()).toBeNull();
  });

  test("the reverse: settings.write without workspace.create", async () => {
    renderSidebar({
      capabilities: { "workspace.create": false, "settings.write": true },
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(settingsControl()).toBeInTheDocument());
    expect(newWorkspaceControl()).toBeNull();
  });

  test("single-user mode gets both", async () => {
    renderSidebar({ capabilities: {}, user: null });
    await waitFor(() => expect(settingsControl()).toBeInTheDocument());
    expect(newWorkspaceControl()).toBeInTheDocument();
  });
});
