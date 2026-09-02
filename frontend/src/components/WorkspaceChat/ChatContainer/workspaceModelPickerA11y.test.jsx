// #124 — the workspace model picker must announce what it IS, not what it currently holds.
//
// Today the button's only accessible name is its text content, which is the current model name.
// A screen-reader user hears "gpt-4o-mini" — a value, with nothing saying it is a control or
// what activating it does. That name also changes under them whenever the model changes, so it
// cannot be learned or searched for. The one time it announces its purpose is the fallback path
// where no model is set, i.e. only when it has nothing useful to say.
//
// The trap this suite exists to close: `aria-label={modelName}` would satisfy "the button has an
// accessible name" and fix nothing. So the name is asserted to be CONSTANT across two different
// model values, which is the assertion that rejects the plausible-looking fix.
//
// QA-3 correction. An earlier version of this file claimed to be RED before the fix and was
// not: its matcher `/select_model|select model/i` matched the button's VISIBLE TEXT during the
// fallback window (before the async model name arrives, the span reads the same key), so
// `getByRole` found the button whether or not an aria-label existed. Deleting the label
// entirely left 4/4 green.
//
// Two rules came out of that, and both shape the assertions below:
//   1. Every test waits for the RESOLVED state — the model name on screen — before asking for
//      the button. In the fallback window the visible text and the intended label are the same
//      string, so nothing can be distinguished there.
//   2. The name is asserted to be a NON-EMPTY string, not merely equal across renders.
//      `getAttribute("aria-label")` returns null when the attribute is absent, and
//      `null === null` made the constancy test pass for a button with no label at all.

// A note on the matcher. i18next is not initialised under vitest, so `t("chat_window.select_model")`
// returns the KEY rather than "Select Model". The tests therefore match the key, which is what
// the DOM actually carries here — matching the English string would pass only if a test happened
// to initialise i18n, and would fail for the wrong reason otherwise. What is being asserted is
// that the name is constant and describes the control, and the key satisfies both.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mockCapabilities = vi.hoisted(() => ({
  current: {
    capabilities: {},
    workspace: { id: 7, capabilities: { "workspace.write": true } },
    error: null,
  },
}));
const mockModelName = vi.hoisted(() => ({ current: "gpt-4o-mini" }));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => mockCapabilities.current,
    keys: async () => ({}),
    getSystemSettings: async () => ({
      LLMProvider: "openai",
      LLMModel: mockModelName.current,
    }),
    getSlashCommandPresets: async () => [],
  },
}));
// `Workspace.bySlug` resolves to the workspace ITSELF, not `{workspace}` — it unwraps the
// response internally (`models/workspace.js:249`). Mocking the wrapper shape made
// `workspace.chatModel` undefined and the model name never rendered, so the visible-text test
// failed for a reason that had nothing to do with the label. A mock that does not match the
// real return shape tests the mock.
vi.mock("@/models/workspace", () => ({
  default: {
    bySlug: async () => ({
      id: 7,
      slug: "test",
      chatProvider: "openai",
      chatModel: mockModelName.current,
    }),
  },
}));
vi.mock("@/models/modelRouter", () => ({
  default: { getRouter: async () => ({ router: null }) },
}));
vi.mock("@/hooks/useUser", () => ({
  default: () => ({ user: null }),
}));

import WorkspaceModelPicker from "@/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker";
import { resetCapabilities } from "@/hooks/useCapabilities";

const renderPicker = () =>
  render(
    <MemoryRouter initialEntries={["/workspace/test"]}>
      <WorkspaceModelPicker workspaceSlug="test" workspaceId={7} />
    </MemoryRouter>
  );

beforeEach(() => {
  resetCapabilities();
  mockModelName.current = "gpt-4o-mini";
});
afterEach(() => vi.clearAllMocks());

describe("#124: the model picker announces its purpose, not its value", () => {
  test("the button is reachable by an accessible name that says what it does", async () => {
    renderPicker();

    // Wait for the RESOLVED state first. Before the model name arrives the visible text is the
    // same string as the intended label, so a match here would prove nothing about the label.
    await waitFor(() =>
      expect(screen.getByText(/gpt-4o-mini/i)).toBeInTheDocument()
    );

    const button = screen.getByRole("button", {
      name: /select_model|select model/i,
    });
    // And the name must come from the LABEL, not from the text content — which now reads
    // "gpt-4o-mini". Asserted explicitly so deleting the attribute fails here.
    expect(button.getAttribute("aria-label")).toMatch(
      /select_model|select model/i
    );
  });

  test("the accessible name does NOT change when the model changes", async () => {
    // The assertion that rejects `aria-label={modelName}` — a "fix" that gives the button a
    // name while leaving it a moving value the user cannot learn.
    //
    // Written as TWO SEPARATE RENDERS with different model data, comparing the names. The
    // earlier version of this test unmounted and remounted, which reset the component and let
    // the mutant through: with `aria-label={modelName}` each render produced a name matching
    // the matcher only because the FALLBACK path was hit before the async model name arrived,
    // so both reads happened before either name changed. Mutation caught that; the fix is to
    // read the name AFTER the model has resolved in each render, which is when a
    // value-derived label actually differs.
    mockModelName.current = "gpt-4o-mini";
    const first = renderPicker();
    await waitFor(() =>
      expect(screen.getByText(/gpt-4o-mini/i)).toBeInTheDocument()
    );
    const firstName = screen
      .getByRole("button", { name: /select_model|select model|gpt-4o-mini/i })
      .getAttribute("aria-label");
    first.unmount();

    resetCapabilities();
    mockModelName.current = "claude-sonnet-4";
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText(/claude-sonnet-4/i)).toBeInTheDocument()
    );
    const secondName = screen
      .getByRole("button", {
        name: /select_model|select model|claude-sonnet-4/i,
      })
      .getAttribute("aria-label");

    // Non-empty on BOTH sides before comparing. `getAttribute` returns null for a missing
    // attribute, and `null === null` passed happily for a button carrying no label at all —
    // the mutant QA-3 found. Equality alone is not the property; a stable NAME is.
    expect(firstName).toEqual(expect.any(String));
    expect(firstName.length).toBeGreaterThan(0);
    expect(secondName).toBe(firstName);
  });

  test("the VISIBLE text still shows the model — the label does not replace it", async () => {
    // Sighted users read the current model off this control; the fix must add an accessible
    // name without taking away the information the visible text carries. A change that set the
    // text to "Select Model" would pass both tests above and make the control less useful.
    mockModelName.current = "claude-sonnet-4";
    renderPicker();

    await waitFor(() =>
      expect(screen.getByText(/claude-sonnet-4/i)).toBeInTheDocument()
    );
  });

  test("with NO model set, the control keeps the same accessible name", async () => {
    // The fallback path. Without this, an implementation could label the button only when a
    // model is set, and the control would change identity depending on workspace state — the
    // same "name that moves" defect in a quieter form.
    mockModelName.current = "";
    renderPicker();

    // With no model the visible text IS the fallback key, so `getByRole` matching a name here
    // cannot tell a label from the text. The attribute is asserted directly instead.
    const button = await waitFor(() =>
      screen.getByRole("button", { name: /select_model|select model/i })
    );

    expect(button.getAttribute("aria-label")).toMatch(
      /select_model|select model/i
    );
  });
});
