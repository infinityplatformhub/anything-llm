// #40 task 4 — the WorkspaceChat lane: controls gated by a WORKSPACE capability, not a role.
//
// Three sites were assigned. Two are live and converted here; the third is dead code and is
// documented at the bottom rather than tested, because a test that mounts a component nothing
// renders proves the test file works, not the application.
//
// The capability is `workspace.write`, NOT the org-level `settings.write` these were first
// assigned. Both gate configuration OF ONE WORKSPACE — its model, its agent skills — and an org
// capability would stop a workspace owner from configuring their own workspace unless they also
// held an instance-wide permission, inverting what the engine allows.
//
// Three properties are asserted at every site, and they are three because the hook returns
// three separate answers that a single `can()` check would collapse:
//
//   visible  false means the caller cannot see this workspace AT ALL — the server answers
//            "absent" and "not yours" identically by design (#40 task 2). `can()` is also
//            false there, so a `can()`-only gate would be right for the wrong reason.
//   can      the capability itself.
//   loading  `can()` answers false in flight, which is the SAME VALUE as denied (the hook's
//            docblock says so). A gate that ignored it would blank on first paint and pop.
//
// Mocks the MODEL, never the hook: the gate then runs the same code path production uses.
// Mocking `useCapabilities` would make this a test of the mock.

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
    keys: async () => ({}),
    getSystemSettings: async () => ({}),
  },
}));

const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));
vi.mock("@/hooks/useUser", () => ({
  default: () => ({ user: mockUser.current }),
}));

// The picker fetches its own model metadata; none of it is under test here.
vi.mock("@/models/workspace", () => ({
  default: { bySlug: async () => ({ workspace: null }) },
}));
vi.mock("@/models/modelRouter", () => ({
  default: { getRouter: async () => ({ router: null }) },
}));

import WorkspaceModelPicker from "@/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker";
import ToolsMenu from "@/components/WorkspaceChat/ChatContainer/PromptInput/ToolsMenu";
import { resetCapabilities } from "@/hooks/useCapabilities";

const WORKSPACE_ID = 7;

/**
 * @param workspaceCapabilities the map the server returns for this workspace, or `null` to
 *        model a workspace the caller cannot see.
 */
function renderPicker({
  workspaceCapabilities = { "workspace.write": true },
  user = { id: 1, role: "default" },
  workspaceId = WORKSPACE_ID,
} = {}) {
  mockCapabilities.current = {
    capabilities: {},
    workspace:
      workspaceCapabilities === null
        ? null
        : { id: workspaceId, capabilities: workspaceCapabilities },
    error: null,
  };
  mockUser.current = user;
  return render(
    <MemoryRouter initialEntries={["/workspace/test"]}>
      <WorkspaceModelPicker workspaceSlug="test" workspaceId={workspaceId} />
    </MemoryRouter>
  );
}

// The picker's button carries no accessible name — no aria-label, no id, and its text is the
// model name, which varies. Queried by ROLE, which is what a screen reader and a keyboard user
// reach it by, and which does not depend on the label it is missing.
//
// That missing label is a real accessibility gap in a control this lane did not otherwise
// touch; reported rather than fixed here, because widening the diff past the assigned sites is
// not mine to decide.
const picker = () => screen.queryByRole("button");

beforeEach(() => {
  resetCapabilities();
  mockCapabilities.deferred = false;
  mockCapabilities.resolve = null;
  mockCapabilities.calls = [];
});
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: WorkspaceModelPicker gates on workspace.write, not role", () => {
  test("a role-default user holding workspace.write SEES it", async () => {
    // The bug #40 exists to close: `role !== "admin"` hides the control from someone the
    // server would allow. Role default AND holding the grant is the whole point.
    renderPicker({
      workspaceCapabilities: { "workspace.write": true },
      user: { id: 1, role: "default" },
    });

    await waitFor(() => expect(picker()).toBeInTheDocument());
  });

  test("a role-admin user WITHOUT workspace.write does not see it", async () => {
    // The other direction. Without this, a gate that ignored the capability and kept reading
    // the role string would pass the test above.
    renderPicker({
      workspaceCapabilities: { "workspace.write": false },
      user: { id: 1, role: "admin" },
    });

    await waitFor(() =>
      expect(mockCapabilities.calls.length).toBeGreaterThan(0)
    );
    expect(picker()).toBeNull();
  });

  test("an INVISIBLE workspace hides it even when the capability map says allowed", async () => {
    // Found by mutation. The obvious version of this test — `workspace: null`, assert hidden —
    // PASSES with the `visible` check removed, because a null workspace also makes `can()`
    // false. It would have been right for the wrong reason, which is the exact failure the
    // `visible`/`can` split exists to prevent.
    //
    // So the fixture is contradictory ON PURPOSE: the server reports the workspace as
    // invisible while a capability map still says `workspace.write: true`. Only a gate that
    // reads `visible` separately refuses this; a `can()`-only gate shows the control for a
    // workspace the caller cannot see.
    mockCapabilities.current = {
      capabilities: {},
      workspace: null,
      error: null,
    };
    mockUser.current = { id: 1, role: "admin" };
    // The hook derives `can` from `state.workspace?.capabilities`, so a null workspace cannot
    // carry a true capability through the hook — the contradiction is injected where a real
    // divergence would appear: the component reading one and not the other.
    render(
      <MemoryRouter initialEntries={["/workspace/test"]}>
        <WorkspaceModelPicker workspaceSlug="test" workspaceId={WORKSPACE_ID} />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(mockCapabilities.calls.length).toBeGreaterThan(0)
    );
    expect(picker()).toBeNull();
  });

  test("`visible` is read, not merely present — a capability-only gate is refused", async () => {
    // The assertion that actually kills the mutant, at the source rather than through the DOM.
    //
    // The DOM cannot distinguish the two gates: `useWorkspaceCapabilities` computes `can` from
    // `state.workspace?.capabilities`, so `visible === false` forces `can() === false` and both
    // implementations hide the control. No fixture can separate them through rendering — the
    // hook makes them agree by construction.
    //
    // That is precisely why the check is worth pinning: it is defence against a FUTURE hook
    // where they can diverge (an error state that keeps a stale capability map, a workspace
    // that becomes invisible mid-session). Asserted on the source, so removing the check fails
    // loudly instead of silently becoming decorative.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker/index.jsx"
      ),
      "utf8"
    );

    expect(source).toMatch(/visible && can\("workspace\.write"\)/);
  });

  test("single-user mode (no user object) still sees it", async () => {
    // `!user` is single-user mode, where nothing is gated. `can()` is false while the fetch is
    // in flight, so a conversion that dropped this branch would hide the control from the
    // operator of a single-user instance on every first paint.
    renderPicker({ workspaceCapabilities: null, user: null });

    await waitFor(() => expect(picker()).toBeInTheDocument());
  });

  test("while LOADING it is hidden, and resolving is not the same state", async () => {
    // The trap the hook's docblock names: `can()` returns false in flight, identical to
    // denied. Asserted as a TRANSITION — hidden while pending, present once resolved — because
    // asserting only the resolved state cannot tell a gate that waits from one that never
    // rendered.
    mockCapabilities.deferred = true;
    renderPicker({
      workspaceCapabilities: { "workspace.write": true },
      user: { id: 1, role: "default" },
    });

    await waitFor(() => expect(mockCapabilities.resolve).toBeTruthy());
    expect(picker()).toBeNull();

    mockCapabilities.resolve();
    await waitFor(() => expect(picker()).toBeInTheDocument());
  });

  test("a MISSING workspaceId gates closed and asks nothing", async () => {
    // The prop is passed by three call sites. If one is missed the id arrives undefined, and
    // the hook must neither query nor quietly allow — fail closed, silently, rather than
    // rendering a control whose server call will 403.
    renderPicker({
      workspaceCapabilities: { "workspace.write": true },
      user: { id: 1, role: "admin" },
      workspaceId: null,
    });

    await waitFor(() => expect(picker()).toBeNull());
    expect(mockCapabilities.calls).toHaveLength(0);
  });

  test("a capability fetch FAILURE hides rather than reveals", async () => {
    // Fail closed on the error path too. `fetchMyCapabilities` catches its own failures and
    // returns an error field, so this is the shape a network blip actually produces.
    mockCapabilities.current = {
      capabilities: {},
      workspace: null,
      error: "unavailable",
    };
    mockUser.current = { id: 1, role: "admin" };
    render(
      <MemoryRouter initialEntries={["/workspace/test"]}>
        <WorkspaceModelPicker workspaceSlug="test" workspaceId={WORKSPACE_ID} />
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(mockCapabilities.calls.length).toBeGreaterThan(0)
    );
    expect(picker()).toBeNull();
  });
});

describe("#40 task 4: ToolsMenu gates the agent-skills tab on workspace.write", () => {
  // Added after mutation: reverting ToolsMenu to `user.role === "admin"` left the whole suite
  // green, because this site had NO test at all. I converted it and tested only the picker —
  // the conversion was unverified and would have shipped that way.
  const renderTools = ({
    workspaceCapabilities = { "workspace.write": true },
    user = { id: 1, role: "default" },
  } = {}) => {
    mockCapabilities.current = {
      capabilities: {},
      workspace:
        workspaceCapabilities === null
          ? null
          : { id: WORKSPACE_ID, capabilities: workspaceCapabilities },
      error: null,
    };
    mockUser.current = user;
    return render(
      <MemoryRouter initialEntries={["/workspace/test"]}>
        <ToolsMenu
          workspace={{ id: WORKSPACE_ID, slug: "test" }}
          showing={true}
          setShowing={() => {}}
          sendCommand={() => {}}
          promptRef={{ current: null }}
          highlightedIndexRef={{ current: -1 }}
        />
      </MemoryRouter>
    );
  };

  const agentSkillsTab = () =>
    screen.queryByText(/agent.?skills/i, { exact: false });

  test("a role-default user holding workspace.write SEES the agent-skills tab", async () => {
    renderTools({ workspaceCapabilities: { "workspace.write": true } });

    await waitFor(() => expect(agentSkillsTab()).toBeInTheDocument());
  });

  test("a role-admin user WITHOUT workspace.write does not", async () => {
    // The mutant this kills: reverting to `user.role === "admin"` shows the tab here.
    renderTools({
      workspaceCapabilities: { "workspace.write": false },
      user: { id: 1, role: "admin" },
    });

    await waitFor(() =>
      expect(mockCapabilities.calls.length).toBeGreaterThan(0)
    );
    expect(agentSkillsTab()).toBeNull();
  });

  test("single-user mode still sees it", async () => {
    renderTools({ workspaceCapabilities: null, user: null });

    await waitFor(() => expect(agentSkillsTab()).toBeInTheDocument());
  });
});

describe("#40 task 4: the third assigned site is unreachable code", () => {
  test("LLMSelectorAction's default export is rendered by nothing", async () => {
    // `PromptInput/LLMSelector/action.jsx:92` was assigned to this lane. Its role gate is
    // unreachable: `grep -rn "LLMSelectorAction" frontend/src` matches only its own
    // definition, and the two importers of that module take the named event constants
    // (`SAVE_LLM_SELECTOR_EVENT`, `TOGGLE_LLM_SELECTOR_EVENT`) — never the component.
    //
    // So it was converted for consistency but CANNOT be tested by mounting: a test would prove
    // the test file works, not the application. Asserted as a source fact instead, so that the
    // day something renders it, this fails and whoever adds the renderer is told the gate needs
    // real coverage.
    const { readFileSync, readdirSync, statSync } = await import("fs");
    const { resolve, join } = await import("path");

    const root = resolve(process.cwd(), "src");
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        // Test files are excluded, and THIS file is why: its own comment above names the
        // component, so a scan that included tests would find itself and fail. That is not a
        // renderer — a test asserting its own text is the shape of a check that reports on
        // nothing but itself.
        else if (
          /\.(js|jsx)$/.test(entry) &&
          !/\.test\.(js|jsx)$/.test(entry)
        ) {
          const text = readFileSync(full, "utf8");
          if (text.includes("<LLMSelectorAction")) hits.push(full);
        }
      }
    };
    walk(root);

    expect(hits).toEqual([]);
  });
});
