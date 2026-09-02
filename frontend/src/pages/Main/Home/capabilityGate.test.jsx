// #126 — the "no workspaces assigned" gate, RENDERED.
//
// #40 task 4 could not render this: the decision was inline in Home, which
// mounts the whole chat surface, so the test transcribed the gate's source
// instead. That catches a deliberate edit but not drift, and the drift check it
// relied on is now gone (RF-3) because these tests exercise the real component.
//
// The gate takes its decision entirely as props, so there is no app tree here
// and no mocking: what is asserted is what renders.

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import WorkspaceGate from "./WorkspaceGate";

const DEAD_END = <div>no-workspaces-assigned</div>;
const SURFACE = <div>workspace-surface</div>;

function renderGate({
  workspace = null,
  user = { id: 1, role: "default" },
  canCreate = false,
  loading = false,
} = {}) {
  return render(
    <WorkspaceGate
      workspace={workspace}
      user={user}
      canCreate={canCreate}
      loading={loading}
      fallback={DEAD_END}
    >
      {SURFACE}
    </WorkspaceGate>
  );
}

const deadEnd = () => screen.queryByText("no-workspaces-assigned");
const surface = () => screen.queryByText("workspace-surface");

describe("#126 RF-1: the four states, rendered", () => {
  test("holds workspace.create with no workspace yet — not a dead end", () => {
    // RF-4 positive control, and the bug #40 fixed: a `default` user who may
    // create a workspace is not stranded. Without this a gate that renders the
    // dead end for everyone satisfies every negative assertion below.
    renderGate({ canCreate: true });
    expect(surface()).toBeInTheDocument();
    expect(deadEnd()).toBeNull();
  });

  test("lacks workspace.create with no workspace — dead end", () => {
    renderGate({ canCreate: false });
    expect(deadEnd()).toBeInTheDocument();
    expect(surface()).toBeNull();
  });

  test("single-user mode is never sent to the dead end", () => {
    // No user row means no principal and an empty map. A gate that only asked
    // the capability would lock a single-user deployment out of its own app.
    renderGate({ user: null, canCreate: false });
    expect(surface()).toBeInTheDocument();
  });

  test("loading hides the surface, and that differs from the resolved answer", () => {
    // `loading` and `denied` are the SAME value out of can(), so asserting the
    // loading state alone proves nothing — it is the TRANSITION that shows the
    // gate distinguishes them. A gate ignoring `loading` renders the surface in
    // the first assertion and this fails there.
    const view = renderGate({ canCreate: true, loading: true });
    expect(deadEnd()).toBeInTheDocument();

    view.rerender(
      <WorkspaceGate
        workspace={null}
        user={{ id: 1, role: "default" }}
        canCreate={true}
        loading={false}
        fallback={DEAD_END}
      >
        {SURFACE}
      </WorkspaceGate>
    );
    expect(surface()).toBeInTheDocument();
    expect(deadEnd()).toBeNull();
  });
});

describe("#126 RF-5: `!workspace` is a condition in its own right", () => {
  test("having a workspace is never a dead end, whatever the capability", () => {
    // A caller who cannot create but already HAS a workspace must reach it.
    // Collapsing the two conditions into one capability check strands them.
    renderGate({ workspace: { id: 7, slug: "existing" }, canCreate: false });
    expect(surface()).toBeInTheDocument();
    expect(deadEnd()).toBeNull();
  });

  test("having a workspace beats loading too", () => {
    renderGate({
      workspace: { id: 7, slug: "existing" },
      canCreate: false,
      loading: true,
    });
    expect(surface()).toBeInTheDocument();
  });
});
