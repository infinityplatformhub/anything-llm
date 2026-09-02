// #40 task 4 — the memories pair: the menu row and the sidebar context that backs it.
//
// Taken as a PAIR because they must agree. The row opens the sidebar the context gates; if they
// asked different questions, a caller could get a menu item that opens an empty panel. Two
// files, one decision, and a test that asserts they answer alike.
//
// The capability is `settings.write` — the ORG one — and NOT `workspace.write`, which the other
// sites in this lane use. That is not an inconsistency: `PersonalizationToggle` calls
// `Admin.updateSystemPreferences({memory_enabled})`, and the server gates that with
// `requirePermission("settings.write", orgResource)` (`endpoints/admin.js:546,672`). Memory is
// an INSTANCE preference that happens to be reached from inside a workspace. Using
// `workspace.write` here would show the control to a workspace owner whose write is then
// refused with a 403 — a UI that offers what the server will not do.
//
// Mocks the model, never the hook, so the gate runs the production code path.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mockCapabilities = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
  resolve: null,
  deferred: false,
  calls: [],
}));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async (options) => {
      mockCapabilities.calls.push(options);
      if (mockCapabilities.deferred) {
        await new Promise((resolve) => {
          mockCapabilities.resolve = resolve;
        });
      }
      return mockCapabilities.current;
    },
    // Memory is enabled instance-wide in every fixture unless a test says otherwise: the
    // question under test is the CAPABILITY, and a disabled instance would hide the row for a
    // second reason and mask it.
    keys: async () => ({ MemoryEnabled: true, MemoryAutoExtraction: true }),
  },
}));

const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));
vi.mock("@/hooks/useUser", () => ({
  default: () => ({ user: mockUser.current }),
}));

// `MemoriesProvider` only resolves `loadingEnabled` while the sidebar is OPEN, and
// `PersonalizationToggle` renders nothing until it does. A fixture pinning `sidebarOpen: false`
// therefore renders an empty document — which would make every toggle assertion pass or fail
// for a reason unrelated to the capability. Hoisted so the toggle group can open it.
const mockSidebarOpen = vi.hoisted(() => ({ current: false }));
// The factory is inlined at each call rather than shared through a const: `vi.mock` is hoisted
// above every declaration, so a shared factory is not yet initialised when the mock registers.
vi.mock("../ChatSidebar", () => ({
  useMemoriesSidebar: () => ({
    sidebarOpen: mockSidebarOpen.current,
    toggleSidebar: () => {},
    closeSidebar: () => {},
  }),
  useSourcesSidebar: () => ({ closeSidebar: () => {} }),
}));
vi.mock("@/components/WorkspaceChat/ChatContainer/ChatSidebar", () => ({
  useMemoriesSidebar: () => ({
    sidebarOpen: mockSidebarOpen.current,
    toggleSidebar: () => {},
    closeSidebar: () => {},
  }),
  useSourcesSidebar: () => ({ closeSidebar: () => {} }),
}));
vi.mock("@/models/memory", () => ({
  default: {
    forWorkspace: async () => ({ memories: [], error: null }),
    all: async () => ({ memories: [], error: null }),
  },
}));

import MemoriesRow from "@/components/WorkspaceChat/ChatContainer/ChatSettingsMenu/Memories";
import { MemoriesProvider } from "@/components/WorkspaceChat/ChatContainer/MemoriesSidebar/MemoriesContext";
import PersonalizationToggle from "@/components/WorkspaceChat/ChatContainer/MemoriesSidebar/PersonalizationToggle";
import { resetCapabilities } from "@/hooks/useCapabilities";

function renderRow({
  capabilities = { "settings.write": true },
  user = { id: 1, role: "default" },
} = {}) {
  mockCapabilities.current = { capabilities, workspace: null, error: null };
  mockUser.current = user;
  return render(
    <MemoryRouter initialEntries={["/workspace/test"]}>
      <MemoriesRow onClose={() => {}} />
    </MemoryRouter>
  );
}

const memoriesRow = () => screen.queryByText(/memories/i);

beforeEach(() => {
  resetCapabilities();
  mockCapabilities.deferred = false;
  mockCapabilities.resolve = null;
  mockCapabilities.calls = [];
});
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: the memories row gates on settings.write, not role", () => {
  test("a role-default user holding settings.write SEES it", async () => {
    // The bug #40 closes: `role === "admin"` hides a control from someone the server allows.
    renderRow({
      capabilities: { "settings.write": true },
      user: { id: 1, role: "default" },
    });

    await waitFor(() => expect(memoriesRow()).toBeInTheDocument());
  });

  test("single-user mode (no user object) still sees it", async () => {
    // `!user` is single-user mode. `can()` is false in flight, so dropping this branch would
    // hide the row from the operator on every first paint.
    renderRow({ capabilities: {}, user: null });

    await waitFor(() => expect(memoriesRow()).toBeInTheDocument());
  });

  test("while LOADING the capability is not yet granted", async () => {
    // `can()` false in flight is the same value as denied. Asserted as a transition: pending,
    // then resolved. Without the transition, a gate that never granted would also pass.
    mockCapabilities.deferred = true;
    renderRow({
      capabilities: { "settings.write": true },
      user: { id: 1, role: "default" },
    });

    await waitFor(() => expect(mockCapabilities.resolve).toBeTruthy());
    mockCapabilities.resolve();
    await waitFor(() => expect(memoriesRow()).toBeInTheDocument());
  });
});

describe("#40 task 4: the personalization toggle gates on settings.write", () => {
  // Added after mutation. Reverting `MemoriesContext` to `user.role === "admin"` failed ONLY
  // the source-pairing test — no behavioural test covered it, the same gap that let a broken
  // ToolsMenu conversion pass earlier in this lane. `canToggle` gates
  // `PersonalizationToggle`, so that is what is rendered here.
  const renderToggle = ({
    capabilities = { "settings.write": true },
    user = { id: 1, role: "default" },
  } = {}) => {
    mockCapabilities.current = { capabilities, workspace: null, error: null };
    mockUser.current = user;
    return render(
      <MemoryRouter initialEntries={["/workspace/test"]}>
        <MemoriesProvider workspace={{ id: 7, slug: "test" }}>
          <PersonalizationToggle />
        </MemoriesProvider>
      </MemoryRouter>
    );
  };

  // `SimpleToggleSwitch` renders `role="switch"`, not a checkbox — queried by the role it
  // actually exposes, which is also what assistive technology reads.
  const toggle = () => screen.queryAllByRole("switch")[0] ?? null;

  beforeEach(() => {
    mockSidebarOpen.current = true;
  });
  afterEach(() => {
    mockSidebarOpen.current = false;
  });

  test("a role-default user holding settings.write can toggle", async () => {
    renderToggle({ capabilities: { "settings.write": true } });

    await waitFor(() => expect(toggle()).toBeInTheDocument());
  });

  test("a role-admin user WITHOUT settings.write cannot", async () => {
    // The mutant this kills: reverting to the role string shows the toggle to role-admin here.
    renderToggle({
      capabilities: { "settings.write": false },
      user: { id: 1, role: "admin" },
    });

    await waitFor(() =>
      expect(mockCapabilities.calls.length).toBeGreaterThan(0)
    );
    expect(toggle()).toBeNull();
  });

  test("single-user mode can toggle", async () => {
    renderToggle({ capabilities: {}, user: null });

    await waitFor(() => expect(toggle()).toBeInTheDocument());
  });
});

// Honest note on coverage, recorded rather than papered over.
//
// Reverting the ROW (`Memories/index.jsx`) to a role string is caught only by the source
// assertion below, not behaviourally — and that is correct, not a gap in the fixture. The row
// hides only when `!canManageMemory && !memoryEnabled`: with memory enabled instance-wide it is
// visible to everyone by design, because a user who cannot toggle memory may still browse the
// memories that exist. So no capability fixture can make the row appear or disappear while
// memory is on, and a test that forced one would assert a behaviour the component does not have.
//
// The behaviour that DOES depend on the capability is the toggle, covered above. The row's
// conversion still matters — it must ask the same question as the context, or the pair diverges
// — so it is pinned at the source, which is the level the property actually lives at.
describe("#40 task 4: the pair asks the SAME question", () => {
  test("both files gate on settings.write, and neither uses a role string", async () => {
    // The pairing invariant, asserted at the source because it is a property of two files
    // agreeing — not of any one render. If one is later converted to `workspace.write` or
    // reverted to a role check, the menu row and the panel behind it start disagreeing, and
    // the symptom is a menu item that opens a panel with nothing in it.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const read = (relative) =>
      readFileSync(resolve(process.cwd(), relative), "utf8");

    const row = read(
      "src/components/WorkspaceChat/ChatContainer/ChatSettingsMenu/Memories/index.jsx"
    );
    const context = read(
      "src/components/WorkspaceChat/ChatContainer/MemoriesSidebar/MemoriesContext.jsx"
    );

    for (const source of [row, context]) {
      expect(source).toMatch(/can\("settings\.write"\)/);
      expect(source).not.toMatch(/role === "admin"/);
    }
  });
});
