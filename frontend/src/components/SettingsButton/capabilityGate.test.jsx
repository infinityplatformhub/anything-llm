// #40 task 4 — the settings affordance is gated by a capability, not a role string.
//
// The role string cannot see a grant. A `default`-roled user holding a
// `settings.write` grant may in fact write settings, and the server says so;
// the button that hides itself on `role === "default"` is simply wrong about
// that user. This is DoD 3 of #40.
//
// Four states per site, because two of them are indistinguishable if you only
// check the obvious one:
//
//   1. holds the capability      -> shown
//   2. does not hold it          -> hidden
//   3. single-user (no user row) -> shown. There is no principal and the map is
//      empty, so a naive `can(...)` gate locks a single-user deployment out of
//      its own settings. The `!user ||` disjunct must survive.
//   4. still loading             -> hidden, and NOT because it was denied. The
//      hook answers false while loading; a component that renders straight off
//      can() flashes hidden-then-shown. This asserts the resolved state differs
//      from the loading state, which is what "not yet known" means.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// Mock the model, not the hook: the gate then runs through the same code path
// production uses. Mocking useCapabilities would make this a test of the mock.
const mockCapabilities = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
  resolve: null,
  deferred: false,
}));

vi.mock("@/models/system", () => ({
  default: {
    fetchMyCapabilities: async () => {
      if (mockCapabilities.deferred) {
        await new Promise((resolve) => {
          mockCapabilities.resolve = resolve;
        });
      }
      return mockCapabilities.current;
    },
  },
}));

const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));
vi.mock("@/hooks/useUser", () => ({
  default: () => ({ user: mockUser.current }),
}));

import SettingsButton from "@/components/SettingsButton";
import { resetCapabilities } from "@/hooks/useCapabilities";

function renderButton({
  capabilities = {},
  user = { id: 1, role: "default" },
}) {
  mockCapabilities.current = { capabilities, workspace: null, error: null };
  mockUser.current = user;
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SettingsButton />
    </MemoryRouter>
  );
}

const settingsLink = () => screen.queryByLabelText(/settings/i);

beforeEach(() => {
  resetCapabilities();
  mockCapabilities.deferred = false;
  mockCapabilities.resolve = null;
});
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: SettingsButton gates on settings.write, not role", () => {
  test("a user holding settings.write sees it — even at role default", async () => {
    // The bug this closes: `role === "default"` hides the button from a user the
    // server would allow. Role default AND holding the grant is the whole point.
    renderButton({
      capabilities: { "settings.write": true },
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(settingsLink()).toBeInTheDocument());
  });

  test("a user without settings.write does not see it — even at role admin", async () => {
    // The other direction: an admin role string with no grant must not show it,
    // or the capability is decorative.
    renderButton({
      capabilities: { "settings.write": false },
      user: { id: 1, role: "admin" },
    });
    await waitFor(() => expect(screen.queryByLabelText(/home/i)).toBeNull());
    expect(settingsLink()).toBeNull();
  });

  test("single-user mode still shows it", async () => {
    // No user row means no principal and an empty map. Dropping the `!user ||`
    // disjunct locks a single-user deployment out of its own settings.
    renderButton({ capabilities: {}, user: null });
    await waitFor(() => expect(settingsLink()).toBeInTheDocument());
  });

  test("while loading it is hidden, and that is not the resolved answer", async () => {
    mockCapabilities.deferred = true;
    renderButton({
      capabilities: { "settings.write": true },
      user: { id: 1, role: "default" },
    });

    // Loading: hidden. Same rendered output as denied -- which is exactly why
    // the assertion cannot stop here.
    expect(settingsLink()).toBeNull();

    mockCapabilities.resolve?.();
    // Resolved: shown. If these two were the same, a component rendering off
    // can() alone would look correct while flashing on every mount.
    await waitFor(() => expect(settingsLink()).toBeInTheDocument());
  });
});
