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
  rejectOnce: false,
  calls: 0,
  value: { capabilities: { "settings.write": true }, workspace: null },
}));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => {
      mockFetch.calls += 1;
      if (mockFetch.deferred) {
        await new Promise((resolve) => {
          mockFetch.resolve = resolve;
        });
      }
      if (mockFetch.rejectOnce) {
        mockFetch.rejectOnce = false;
        throw new Error("network");
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
  mockFetch.rejectOnce = false;
  mockFetch.calls = 0;
});

describe("#40 M6: a failed fetch is not cached", () => {
  // QA-3 M6. The cache is a module-level promise, so caching a REJECTED one
  // answers every later mount in the tab with the same failure: can() stays
  // false until a manual reload, and a transient network blip becomes
  // indistinguishable from a revoked grant.
  //
  // Asserted through the hook rather than the raw cache, because the bug is
  // only observable to a second reader.
  test("a second mount refetches and gets the real answer", async () => {
    mockFetch.deferred = false;
    mockFetch.rejectOnce = true;

    const first = renderHook(() => useCapabilities());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    // Failed closed, as it must — but the question is what happens NEXT.
    expect(first.result.current.can("settings.write")).toBe(false);
    expect(mockFetch.calls).toBe(1);

    const second = renderHook(() => useCapabilities());
    await waitFor(() =>
      expect(second.result.current.can("settings.write")).toBe(true)
    );
    // A second call actually happened: a cached rejection would have answered
    // from the first without asking again.
    expect(mockFetch.calls).toBe(2);
  });

  test("a successful fetch IS cached — the retry is not a request storm", async () => {
    mockFetch.deferred = false;
    const a = renderHook(() => useCapabilities());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    renderHook(() => useCapabilities());
    renderHook(() => useCapabilities());
    expect(mockFetch.calls).toBe(1);
  });
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
