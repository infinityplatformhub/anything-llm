// #127 — /settings/mobile-connections is behind AdminRoute, matching the permission the server
// actually enforces.
//
// Both routes the page calls are gated `requirePermission("system.read", orgResource)`
// (`endpoints/mobile/index.js:21,86`), and only `super_admin:org` holds `system.read` —
// measured, not read from a migration:
//
//   SELECT r.name, r.scope FROM role_permissions rp
//     JOIN roles r ON r.id = rp.role_id
//     JOIN permissions p ON p.id = rp.permission_id
//    WHERE p.action = 'system.read';   →  super_admin | org
//
// `legacyRoleGrants.js:23` maps `manager → member`, and `member` does not hold it. So under
// ManagerRoute a manager sees the page and gets 403 from BOTH of its calls: a page that renders
// and cannot work.
//
// TL-2's ruling was to fix the guard rather than widen `system.read`. The drift test that keeps
// that true lives on the server side (`__tests__/security/systemReadGrantDrift.test.js`) —
// without it, someone could make the manager case "work" by moving the grant and every test
// here would stay green.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// `useIsAuthenticated` is defined INSIDE PrivateRoute/index.jsx rather than imported, so it
// cannot be mocked directly; its dependencies are mocked instead, which also means the guard
// runs the same code path production does.
const mockKeys = vi.hoisted(() => ({
  current: { MultiUserMode: true, RequiresAuth: true },
}));

vi.mock("@/models/system", () => ({
  default: {
    isOnboardingComplete: async () => true,
    keys: async () => mockKeys.current,
    // Since #40 task 4 the guards ask a CAPABILITY, not a role string, so this fixture must
    // answer the role-equivalent map. An empty map refuses everyone — my first version did
    // exactly that and the positive controls failed while looking like guard failures.
    //
    // Derived from the role under test rather than hardcoded, so a case that changes the role
    // does not silently keep the previous case's capabilities.
    fetchMyCapabilities: async () => ({
      capabilities: {
        "settings.write": mockKeys.current.role === "admin",
        "user.manage": mockKeys.current.role !== "default",
      },
      workspace: null,
      error: null,
    }),
  },
}));
vi.mock("@/utils/session", () => ({ default: async () => true }));
vi.mock("../UserMenu", () => ({
  default: ({ children }) => <>{children}</>,
}));
vi.mock("@/utils/keyboardShortcuts", () => ({
  KeyboardShortcutWrapper: ({ children }) => <>{children}</>,
}));

import { AdminRoute, ManagerRoute } from "@/components/PrivateRoute";
import { resetCapabilities } from "@/hooks/useCapabilities";
import { AUTH_TOKEN, AUTH_USER } from "@/utils/constants";

const MobileConnectionsPage = () => <div>mobile connections</div>;

async function renderWith(Guard, { role, multiUserMode = true }) {
  window.localStorage.setItem(AUTH_USER, JSON.stringify({ id: 1, role }));
  window.localStorage.setItem(AUTH_TOKEN, "a-valid-looking-token");
  mockKeys.current = { MultiUserMode: multiUserMode, RequiresAuth: true, role };

  const view = render(
    <MemoryRouter initialEntries={["/settings/mobile-connections"]}>
      <Guard Component={MobileConnectionsPage} />
    </MemoryRouter>
  );
  // The guard renders a loader until its async session check resolves. Without waiting, every
  // assertion runs against the loader and "the page is not shown" is true for EVERY role —
  // green because nothing has happened yet.
  await waitFor(() => expect(screen.queryByText("loading")).toBeNull());
  return view;
}

const page = () => screen.queryByText("mobile connections");

beforeEach(() => {
  window.localStorage.clear();
  // `useCapabilities` caches its answer in a MODULE-level promise for the session, so without
  // this every test after the first reuses the first one's map — a manager fixture silently
  // running on the admin's capabilities. The cache is correct in production (a grant an admin
  // can revoke must not outlive the tab) and wrong across tests, which is why the hook exports
  // a reset.
  resetCapabilities();
});
afterEach(() => vi.clearAllMocks());

describe("#127 F1: the ROUTE uses AdminRoute, not merely AdminRoute working", () => {
  test("main.jsx pairs /settings/mobile-connections with AdminRoute", async () => {
    // The assertion that actually closes this issue. Every behavioural test below proves what
    // AdminRoute DOES; none of them prove THIS ROUTE uses it — a route left on ManagerRoute
    // would leave them all green while the bug shipped.
    //
    // Read as source: importing `main.jsx` executes the app entry point and mounts every page.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(process.cwd(), "src/main.jsx"), "utf8");

    // Both offsets are asserted BEFORE slicing. `indexOf` returns -1 when it does not match,
    // and `slice(0, -1)` means "everything but the last character" — so a delimiter that
    // stopped matching (a prettier run, a reordered route) would silently widen this to
    // almost the whole file, find `AdminRoute` somewhere else entirely, and pass while THIS
    // route carried no guard at all. QA-3 found exactly that: the assertion failed OPEN.
    const routeStart = source.indexOf('path: "/settings/mobile-connections"');
    expect(routeStart).toBeGreaterThan(0);

    const block = source.slice(routeStart);
    const routeEnd = block.indexOf("},\n      {");
    expect(routeEnd).toBeGreaterThan(0);

    const routeBlock = block.slice(0, routeEnd);

    expect(routeBlock).toMatch(/AdminRoute Component=\{MobileConnections\}/);
    expect(routeBlock).not.toMatch(/ManagerRoute/);
  });
});

describe("#127 F2: the guard is exercised in MULTI-USER mode", () => {
  test("a manager is refused by AdminRoute", async () => {
    // `multiUserMode: true` is load-bearing. Both guards pass everyone when it is false
    // (`|| !multiUserMode`), so a fixture without it is green under AdminRoute and
    // ManagerRoute alike — the accidentally-passing-fixture class from #94 and #49.
    await renderWith(AdminRoute, { role: "manager", multiUserMode: true });

    expect(page()).toBeNull();
  });

  test("ManagerRoute WOULD have admitted that manager — the guards differ", async () => {
    // Why the one-line change is load-bearing rather than cosmetic. If this ever fails, the
    // two guards have converged and this issue's premise needs revisiting.
    await renderWith(ManagerRoute, { role: "manager", multiUserMode: true });

    expect(page()).toBeInTheDocument();
  });

  test("a default-role user is refused", async () => {
    await renderWith(AdminRoute, { role: "default", multiUserMode: true });

    expect(page()).toBeNull();
  });

  test("an admin still reaches the page", async () => {
    // Positive control. Without it, a guard refusing everyone satisfies every test above and
    // ships a page nobody can open.
    await renderWith(AdminRoute, { role: "admin", multiUserMode: true });

    expect(page()).toBeInTheDocument();
  });

  test("single-user mode admits everyone — which is why the fixtures set multiUserMode", async () => {
    // Guards the fixture itself: a test written without the flag passes under AdminRoute for
    // the wrong reason and would keep passing if the guard were swapped back.
    await renderWith(AdminRoute, { role: "default", multiUserMode: false });

    expect(page()).toBeInTheDocument();
  });
});
