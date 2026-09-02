// #111 — the smoke test that proves the harness works.
//
// Deliberately written against a component that ALREADY EXISTED (`Toggle`, unchanged by this
// issue). A harness proven only against a component authored alongside it proves the
// component, not the harness: the two would have been shaped to fit each other, and the first
// real test written later is the one that discovers jsdom, the `@` alias, or the JSX transform
// was never actually exercised.
//
// `Toggle` was chosen because it exercises the parts most likely to be misconfigured:
//   - JSX + React 18 rendering through @vitejs/plugin-react
//   - a third-party ESM import (@phosphor-icons/react) resolving under jsdom
//   - the `@`-alias path used by every source file in this repo
//   - real DOM state (checked / disabled), so the assertions are about behaviour rather than
//     about whether a string appears
//
// It is a harness proof, not Toggle coverage. Component-level testing is its own work.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import Toggle from "@/components/lib/Toggle";

describe("#111 harness: the frontend test stack renders and asserts on real DOM", () => {
  test("a component renders and its label reaches the document", () => {
    render(<Toggle label="Multi-user mode" />);

    expect(screen.getByText("Multi-user mode")).toBeInTheDocument();
  });

  test("the rendered control is a real checkbox, not a div that looks like one", () => {
    // getByRole goes through the accessibility tree, so this fails if the harness renders
    // markup without semantics — which is also what a screen reader would hit.
    render(<Toggle label="Multi-user mode" name="multi_user" />);

    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  test("a controlled toggle reports the new state to its handler", async () => {
    // The assertion that proves EVENTS work, not just rendering. A harness that mounts
    // components but cannot dispatch a click would pass both tests above and be useless for
    // every test S11b needs.
    const onChange = vi.fn();
    render(
      <Toggle label="Multi-user mode" enabled={false} onChange={onChange} />
    );

    await userEvent.click(screen.getByRole("checkbox"));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("a disabled toggle does not report a change", async () => {
    // The negative half. Without it, a handler that fired on every click — including ones the
    // component should swallow — would satisfy the test above.
    const onChange = vi.fn();
    render(
      <Toggle
        label="Multi-user mode"
        enabled={false}
        onChange={onChange}
        disabled
      />
    );

    await userEvent.click(screen.getByRole("checkbox"));

    expect(onChange).not.toHaveBeenCalled();
  });

  test("state is not carried between tests", () => {
    // Guards the setup file's `cleanup()`. Without unmounting between tests, renders
    // accumulate in document.body and a getBy* query can find the PREVIOUS test's element —
    // passing for the wrong reason. Every test above rendered a toggle labelled
    // "Multi-user mode"; if any survived, this finds one before rendering anything.
    expect(screen.queryByText("Multi-user mode")).toBeNull();
  });
});
