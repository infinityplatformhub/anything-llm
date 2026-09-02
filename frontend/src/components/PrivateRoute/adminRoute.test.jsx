// S11b (#108) N8 — the mailer page is behind AdminRoute, and that is not interchangeable with
// the ManagerRoute used by the settings page next to it.
//
// Measured on seeded data before this was written:
//
//   SELECT r.name FROM role_permissions rp
//     JOIN roles r ON r.id = rp.role_id
//     JOIN permissions p ON p.id = rp.permission_id
//    WHERE p.action = 'system.write';
//   → super_admin
//
// and `server/utils/authorization/legacyRoleGrants.js:23` maps `admin -> super_admin`,
// `manager -> member`, `default -> member`. All three mailer routes are gated
// `requirePermission("system.write", orgResource)`, so a manager passing ManagerRoute would
// see the page and get 403 from every call — a page that renders and cannot work.
//
// TL-2 N8: `multiUserMode` MUST be true and the role MUST be "manager", or the test proves
// nothing. Both guards let everyone through in single-user mode (`|| !multiUserMode`), so a
// fixture missing that flag passes under AdminRoute and ManagerRoute alike — the same
// accidentally-passing-fixture class as #94's dotted host and #49's twin stamps.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

// `useIsAuthenticated` is defined INSIDE PrivateRoute/index.jsx, not imported, so it cannot be
// mocked directly. Its three dependencies are mocked instead — which is better anyway: the
// guard is exercised through the same code path production uses, rather than through a stubbed
// hook that could drift from it.
const mockKeys = vi.hoisted(() => ({
  current: { MultiUserMode: true, RequiresAuth: true },
}));

vi.mock("@/models/system", () => ({
  default: {
    isOnboardingComplete: async () => true,
    keys: async () => mockKeys.current,
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
import { AUTH_TOKEN, AUTH_USER } from "@/utils/constants";

const Secret = () => <div>mailer settings</div>;

async function renderWith(Guard, { role, multiUserMode }) {
  window.localStorage.setItem(AUTH_USER, JSON.stringify({ id: 1, role }));
  window.localStorage.setItem(AUTH_TOKEN, "a-valid-looking-token");
  mockKeys.current = { MultiUserMode: multiUserMode, RequiresAuth: true };

  const view = render(
    <MemoryRouter initialEntries={["/settings/mailer"]}>
      <Guard Component={Secret} />
    </MemoryRouter>
  );
  // The guard renders a loader until its async session check resolves. Without waiting, every
  // assertion below runs against the loader and "the page is not shown" passes for every role
  // — a test that is green because nothing has happened yet.
  await waitFor(() => expect(screen.queryByText("loading")).toBeNull());
  return view;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.clearAllMocks());

describe("#108 N8: the mailer page's guard matches the permission the server enforces", () => {
  test("a manager is NOT shown the page under AdminRoute", async () => {
    await renderWith(AdminRoute, { role: "manager", multiUserMode: true });

    expect(screen.queryByText("mailer settings")).toBeNull();
  });

  test("an admin IS shown the page", async () => {
    // Positive control. Without it, a guard that refused everyone would satisfy the test
    // above and ship a page nobody can reach.
    await renderWith(AdminRoute, { role: "admin", multiUserMode: true });

    expect(screen.getByText("mailer settings")).toBeInTheDocument();
  });

  test("ManagerRoute WOULD have let the manager in — the guards are not interchangeable", async () => {
    // The reason the choice is load-bearing rather than stylistic, asserted rather than
    // argued in a comment. If this ever fails, the two guards have converged and the note on
    // #66 explaining the asymmetry needs revisiting.
    await renderWith(ManagerRoute, { role: "manager", multiUserMode: true });

    expect(screen.getByText("mailer settings")).toBeInTheDocument();
  });

  test("in single-user mode both guards admit everyone — which is why the fixture sets multiUserMode", async () => {
    // Guards the fixture itself. A test written without `multiUserMode: true` passes under
    // AdminRoute for the wrong reason, and would keep passing if someone swapped the guard.
    await renderWith(AdminRoute, { role: "default", multiUserMode: false });

    expect(screen.getByText("mailer settings")).toBeInTheDocument();
  });
});

describe("#108: the mailer route in main.jsx is actually mounted under AdminRoute", () => {
  test("the source pairs /settings/mailer with AdminRoute", async () => {
    // The behavioural tests above prove what AdminRoute DOES. They cannot prove the mailer
    // page is behind it — a route swapped to ManagerRoute would leave every one of them green
    // while the page shipped to managers who get 403 from every call.
    //
    // Asserted on the source because the route table is lazy-loaded: importing main.jsx to
    // inspect it would execute the app's entry point, mount the router, and pull in every
    // page. Reading the file is the cheaper truth, and it fails on exactly the edit that
    // matters.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(process.cwd(), "src/main.jsx"), "utf8");

    const block = source.slice(source.indexOf('path: "/settings/mailer"'));
    const routeEnd = block.indexOf("},\n      {");
    expect(block.slice(0, routeEnd)).toMatch(
      /AdminRoute Component=\{GeneralMailer\}/
    );
  });
});
