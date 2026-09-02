// #40 task 4 — the privacy link in the settings sidebar.
//
// The capability is not guessed: the link opens /settings/privacy, which
// main.jsx:213 wraps in AdminRoute, and AdminRoute asks settings.write. Reading
// it off the route rather than off the role string matters because the role
// string is what is being removed -- deriving the new check from the old one
// would carry forward whatever drift the old one had.

import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockCapabilities = vi.hoisted(() => ({
  current: { capabilities: {}, workspace: null, error: null },
}));
const mockUser = vi.hoisted(() => ({ current: { id: 1, role: "default" } }));

vi.mock("@/models/system", () => ({
  default: { fetchMyCapabilities: async () => mockCapabilities.current },
}));

import useCapabilities, { resetCapabilities } from "@/hooks/useCapabilities";

// SettingsSidebar renders the whole settings surface (logo, menu tree, app
// version, support email), so it is transcribed here. The drift check below is
// what keeps that honest.
function PrivacyLinkGate() {
  const { can, loading } = useCapabilities();
  const user = mockUser.current;
  const hidePrivacyLink = !!user && (loading || !can("settings.write"));
  return <a hidden={hidePrivacyLink}>settings.privacy</a>;
}

const link = () => screen.queryByText("settings.privacy");

const HOLDS_SETTINGS_ONLY = {
  "settings.write": true,
  "workspace.create": false,
};
const HOLDS_CREATE_ONLY = {
  "settings.write": false,
  "workspace.create": true,
};

function renderGate({ capabilities, user }) {
  mockCapabilities.current = { capabilities, workspace: null, error: null };
  mockUser.current = user;
  return render(<PrivacyLinkGate />);
}

// Renders a probe whose text flips once the hook settles, so a test can wait
// for "the map arrived" instead of for something already true on the first tick
// (TL-1: waiting on the fixture asserts against the LOADING state, and passes
// even for a can() that always answers true).
function CapabilityProbe() {
  const { loading } = useCapabilities();
  return <span>{loading ? "caps-loading" : "caps-ready"}</span>;
}

async function waitForCapabilitiesToLoad() {
  render(<CapabilityProbe />);
  await screen.findByText("caps-ready");
}

beforeEach(() => resetCapabilities());
afterEach(() => vi.clearAllMocks());

describe("#40 task 4: the privacy link follows AdminRoute's capability", () => {
  test("the transcribed gate still matches both sites in SettingsSidebar", () => {
    // Two call sites (mobile and desktop) share one computed value. If either
    // stops using it, or the value changes, these tests no longer describe the
    // component -- the #115 failure mode, caught here rather than in review.
    const source = readFileSync(`${__dirname}/index.jsx`, "utf8");
    expect(source).toContain(
      'const hidePrivacyLink = !!user && (loading || !can("settings.write"));'
    );
    expect(source.match(/hidden=\{hidePrivacyLink\}/g)).toHaveLength(2);
    // And the role string is gone from both, not merely unused.
    expect(source).not.toContain('user.role !== "admin"');
  });

  test("a default-roled user holding settings.write sees the link", async () => {
    renderGate({
      capabilities: HOLDS_SETTINGS_ONLY,
      user: { id: 1, role: "default" },
    });
    await waitFor(() => expect(link()).toBeVisible());
  });

  test("an admin-roled user without settings.write does not", async () => {
    renderGate({
      capabilities: HOLDS_CREATE_ONLY,
      user: { id: 1, role: "admin" },
    });
    await waitForCapabilitiesToLoad();
    expect(link()).not.toBeVisible();
  });

  test("single-user mode sees it", async () => {
    renderGate({ capabilities: {}, user: null });
    await waitFor(() => expect(link()).toBeVisible());
  });
});
