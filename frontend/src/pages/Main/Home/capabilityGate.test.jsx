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

describe("#126 QA-3: the call site, which no render test can reach", () => {
  // A text guard, deliberately, and narrow on purpose.
  //
  // The tests above render WorkspaceGate and prove the DECISION is right. They
  // say nothing about whether Home asks it — nothing imports Home, because
  // mounting it drags in the chat surface, which is the whole reason the gate
  // was extracted. So three claims live outside their reach:
  //
  //   N1  the condition is not also written inline, where two copies drift
  //   N4  BOTH return paths go through the gate, not just one
  //   N6  the gate is called at all, rather than being dead code
  //
  // #40 task 4's source assertion held N1 and N6. Deleting it under RF-3 was
  // wrong: "the render test covers the component" and "the render test covers
  // the call site" are different claims, and only the first was true. QA-3
  // caught it by making WorkspaceGate dead code and watching 93 tests pass.
  //
  // Comments are stripped before matching (§7.17): a check that reads prose
  // reports kills it did not make — the same failure three times over in task 4.
  const homeSource = () => {
    const { readFileSync } = require("fs");
    return readFileSync(`${__dirname}/index.jsx`, "utf8")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  };

  test("N6: Home actually calls the gate", () => {
    expect(homeSource()).toMatch(/<WorkspaceGate/);
  });

  test("N4: every return path goes through it", () => {
    // Two returns in Home itself. A gate on one path leaves the other
    // ungated, which is invisible to a component test.
    expect(homeSource().match(/return gate\(/g)).toHaveLength(2);
  });

  test("N1: the condition is not duplicated at the call site", () => {
    // A second copy would decide first, leaving the gate ornamental and free
    // to drift from the copy that actually runs.
    expect(homeSource()).not.toMatch(
      /!workspace && user && \(loading \|\| !can\(/
    );
  });

  test("the action string is the one the gate is asked about", () => {
    // TL-1's nit: `canCreate` is evaluated at the CALLER, so the action string
    // sits outside the component under test — swapping it to workspace.write
    // leaves every render test green.
    expect(homeSource()).toMatch(/canCreate=\{can\("workspace\.create"\)\}/);
  });
});
