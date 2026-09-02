// #40 task 4 RF-3 — can()'s answer while the map is still loading.
//
// Every gate in task 4 is written `if (user && (loading || !can(...)))`. That
// makes `loading ||` redundant TODAY, because can() already answers false
// against an empty map. Redundant is not the same as unnecessary: the two
// checks are independent defences, and no DOM test can tell them apart --
// breaking either one alone leaves every site green, and only breaking both
// turns anything red.
//
// So the hook's own contract is asserted here, directly, where a single
// mutation can fail it.

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFetch = vi.hoisted(() => ({
  resolve: null,
  deferred: true,
  value: { capabilities: { "settings.write": true }, workspace: null },
}));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => {
      if (mockFetch.deferred) {
        await new Promise((resolve) => {
          mockFetch.resolve = resolve;
        });
      }
      return mockFetch.value;
    },
  },
}));

import useCapabilities, { resetCapabilities } from "@/hooks/useCapabilities";

beforeEach(() => {
  resetCapabilities();
  mockFetch.deferred = true;
  mockFetch.resolve = null;
});

describe("#40 RF-3: can() answers false for everything while loading", () => {
  test("no action is allowed before the map arrives", async () => {
    const { result } = renderHook(() => useCapabilities());

    expect(result.current.loading).toBe(true);
    // Including an action the resolved map says TRUE: answering it early would
    // show a control for a beat and is indistinguishable, in the DOM, from the
    // gate's own loading check doing the work.
    expect(result.current.can("settings.write")).toBe(false);
    expect(result.current.can("workspace.create")).toBe(false);
    expect(result.current.can("anything.at.all")).toBe(false);

    mockFetch.resolve?.();

    // Positive control: the false answers above must be about TIMING, not about
    // a hook that denies everything. Without this the test passes against a
    // can() hardwired to false.
    await waitFor(() =>
      expect(result.current.can("settings.write")).toBe(true)
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.can("workspace.create")).toBe(false);
  });
});
