// #40 task 4 — the admin keyboard shortcuts.
//
// The shortcuts navigate to settings pages, which AdminRoute guards on
// settings.write, so that is the capability. Read off the routes the shortcuts
// open, not off the role string being replaced.
//
// This site differs from the visual ones: an unregistered listener has no
// loading state a user can see. Waiting means the shortcut is inert for a
// moment, so the effect re-runs when the map arrives rather than deciding once.

import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockCaps = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
  resolve: null,
  deferred: false,
}));
const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => {
      if (mockCaps.deferred) {
        await new Promise((resolve) => {
          mockCaps.resolve = resolve;
        });
      }
      return mockCaps.current;
    },
  },
}));

vi.mock("./request", () => ({
  userFromStorage: () => mockUser.current,
  baseHeaders: () => ({}),
}));

import { KeyboardShortcutWrapper } from "./keyboardShortcuts";
import { resetCapabilities } from "@/hooks/useCapabilities";

const HOLDS_SETTINGS_ONLY = {
  "settings.write": true,
  "workspace.create": false,
};
const HOLDS_CREATE_ONLY = {
  "settings.write": false,
  "workspace.create": true,
};

// The listener is the observable: counting keydown registrations is what
// "registered" means here, since nothing renders.
let addSpy;

function renderWrapper({ capabilities, user }) {
  mockCaps.current = { capabilities, workspace: null, error: null };
  mockUser.current = user;
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <KeyboardShortcutWrapper>
        <div>child</div>
      </KeyboardShortcutWrapper>
    </MemoryRouter>
  );
}

const registered = () =>
  addSpy.mock.calls.filter(([event]) => event === "keydown").length > 0;

beforeEach(() => {
  resetCapabilities();
  mockCaps.deferred = false;
  mockCaps.resolve = null;
  addSpy = vi.spyOn(window, "addEventListener");
});
afterEach(() => vi.restoreAllMocks());

describe("#40 task 4: admin shortcuts follow settings.write", () => {
  test("a default-roled user holding settings.write gets the shortcuts", async () => {
    renderWrapper({
      capabilities: HOLDS_SETTINGS_ONLY,
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(registered()).toBe(true));
  });

  test("an admin-roled user without settings.write does not", async () => {
    renderWrapper({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 1, role: "admin" },
    });
    // Wait for the map to arrive before concluding: asserting immediately would
    // pass because loading also withholds the listener.
    await waitFor(() => expect(mockCaps.resolve).toBeNull());
    expect(registered()).toBe(false);
  });

  test("single-user mode gets them", async () => {
    renderWrapper({ capabilities: {}, user: null });
    await waitFor(() => expect(registered()).toBe(true));
  });

  test("the listener is registered once the map arrives, not before", async () => {
    mockCaps.deferred = true;
    renderWrapper({
      capabilities: HOLDS_SETTINGS_ONLY,
      user: { id: 1, role: "default" },
    });
    expect(registered()).toBe(false);

    mockCaps.resolve?.();
    // The effect re-runs on `loading` changing -- without that dependency the
    // shortcut would stay dead for the life of the mount.
    await waitFor(() => expect(registered()).toBe(true));
  });
});
