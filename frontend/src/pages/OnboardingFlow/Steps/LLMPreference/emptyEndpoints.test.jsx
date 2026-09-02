/**
 * #114 R10: the pre-user body empties endpoint fields, and the onboarding form must not
 * render that any worse than it renders a configured instance.
 *
 * This is why the server sends `""` rather than `null` or omitting the key.
 * `JSON.stringify` drops an `undefined` value, so a field absent on one render and a
 * string on the next makes React hand the input back to the DOM mid-edit.
 *
 * Asserted as a COMPARISON against a populated render, not as "no warnings". These
 * components already warn on a fully configured instance — `OllamaLLMOptions` puts both
 * `value` and `defaultValue` on its auth-token input, and an unrelated field resolves to
 * null — and those warnings are pre-existing, not something #114 introduced. A test
 * demanding zero would fail on `main` for a reason that has nothing to do with this
 * change, and fixing it would mean editing components this issue does not touch.
 *
 * The option components are mounted directly rather than through the onboarding page:
 * the page pulls in the router, i18n and a system fetch, and their absence would fail
 * this for an unrelated reason.
 */
import { render } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import OllamaLLMOptions from "@/components/LLMSelection/OllamaLLMOptions";
import LMStudioOptions from "@/components/LLMSelection/LMStudioOptions";
import LiteLLMOptions from "@/components/LLMSelection/LiteLLMOptions";
import TextGenWebUIOptions from "@/components/LLMSelection/TextGenWebUiOptions";
import AzureAiOptions from "@/components/LLMSelection/AzureAiOptions";

// The auto-discovery hook probes the endpoint over the network when handed an empty
// basePath; left real, each render would attempt a fetch and those failures would read
// as this test's failures.
vi.mock("@/models/system", () => ({
  default: {
    keys: vi.fn(async () => ({})),
    customModels: vi.fn(async () => ({ models: [], error: null })),
    isMultiUserMode: vi.fn(async () => false),
  },
}));

const COMPONENTS = [
  ["OllamaLLMOptions", OllamaLLMOptions],
  ["LMStudioOptions", LMStudioOptions],
  ["LiteLLMOptions", LiteLLMOptions],
  ["TextGenWebUIOptions", TextGenWebUIOptions],
  ["AzureAiOptions", AzureAiOptions],
];

/** Every field reads "" — the shape the pre-user branch sends. */
const emptyBody = new Proxy(
  {},
  { get: (_t, p) => (typeof p === "string" ? "" : undefined), has: () => true }
);

/** Every field carries a value — a configured instance, for the baseline. */
const populatedBody = new Proxy(
  {},
  {
    get: (_t, p) => (typeof p === "string" ? "configured-value" : undefined),
    has: () => true,
  }
);

/** Every field is absent — what omitting the keys, or sending null, would look like. */
const undefinedBody = new Proxy({}, { get: () => undefined, has: () => true });

const CONTROLLED =
  /uncontrolled|controlled input|value prop on|both value and defaultValue/i;

let warnings;
let consoleError;

beforeEach(() => {
  warnings = [];
  // React reports the controlled/uncontrolled switch through console.error; asserting
  // on the rendered DOM would not see it at all.
  consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args) => warnings.push(args.map(String).join(" ")));
});

afterEach(() => consoleError.mockRestore());

/** Render once and return only the controlled/uncontrolled complaints. */
function warningsFor(Component, settings) {
  warnings = [];
  render(<Component settings={settings} />);
  return warnings.filter((line) => CONTROLLED.test(line));
}

describe("issue 114 R10: an empty endpoint renders no worse than a configured one", () => {
  test.each(COMPONENTS)(
    "%s warns no more on the pre-user body than on a populated one",
    (_name, Component) => {
      const populated = warningsFor(Component, populatedBody).length;
      const empty = warningsFor(Component, emptyBody).length;

      expect(empty).toBeLessThanOrEqual(populated);
    }
  );

  test("the harness can see the warning at all, so the comparison means something", () => {
    // Without this, every case above passes equally well if React never warns here —
    // 0 <= 0 — which would make the file decorative. Asserted on a plain input rather
    // than on a provider component: what has to be proven is that this spy captures
    // React's controlled/uncontrolled complaint, and a component that happens to stop
    // rendering a value-bound input would silence it for the wrong reason.
    warnings = [];
    const { rerender } = render(<input value={undefined} readOnly />);
    rerender(<input value="now-controlled" readOnly />);

    expect(
      warnings.filter((line) => CONTROLLED.test(line)).length
    ).toBeGreaterThan(0);
  });

  test("switching a field from absent to a string is what React objects to", () => {
    // The concrete failure "" prevents: `JSON.stringify` omits undefined, so a body
    // without the key gives an uncontrolled input that becomes controlled on the next
    // render. Rendering the empty body twice must NOT do this.
    warnings = [];
    const { rerender } = render(<OllamaLLMOptions settings={undefinedBody} />);
    rerender(<OllamaLLMOptions settings={populatedBody} />);
    const acrossSwitch = warnings.filter((line) =>
      CONTROLLED.test(line)
    ).length;

    warnings = [];
    const stable = render(<OllamaLLMOptions settings={emptyBody} />);
    stable.rerender(<OllamaLLMOptions settings={emptyBody} />);
    const acrossStable = warnings.filter((line) =>
      CONTROLLED.test(line)
    ).length;

    expect(acrossStable).toBeLessThanOrEqual(acrossSwitch);
  });
});
