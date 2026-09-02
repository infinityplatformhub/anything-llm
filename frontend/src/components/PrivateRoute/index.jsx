import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { FullScreenLoader } from "../Preloader";
import useCapabilities from "@/hooks/useCapabilities";
import validateSessionTokenForUser from "@/utils/session";
import paths from "@/utils/paths";
import { AUTH_TIMESTAMP, AUTH_TOKEN, AUTH_USER } from "@/utils/constants";
import { userFromStorage } from "@/utils/request";
import System from "@/models/system";
import UserMenu from "../UserMenu";
import { KeyboardShortcutWrapper } from "@/utils/keyboardShortcuts";

// Used only for Multi-user mode only as we permission specific pages based on auth role.
// When in single user mode we just bypass any authchecks.
function useIsAuthenticated() {
  const [isAuthd, setIsAuthed] = useState(null);
  const [shouldRedirectToOnboarding, setShouldRedirectToOnboarding] =
    useState(false);
  const [multiUserMode, setMultiUserMode] = useState(false);

  useEffect(() => {
    const validateSession = async () => {
      const onboardingComplete = await System.isOnboardingComplete();
      const { MultiUserMode, RequiresAuth } = await System.keys();
      setMultiUserMode(MultiUserMode);

      // Check for the onboarding redirect condition
      if (onboardingComplete === false) {
        setShouldRedirectToOnboarding(true);
        setIsAuthed(true);
        return;
      }

      // Single User mode without password - no auth required
      if (!MultiUserMode && !RequiresAuth) {
        setIsAuthed(true);
        return;
      }

      // Single User password mode check
      if (!MultiUserMode && RequiresAuth) {
        const localAuthToken = localStorage.getItem(AUTH_TOKEN);
        if (!localAuthToken) {
          setIsAuthed(false);
          return;
        }

        const isValid = await validateSessionTokenForUser();
        setIsAuthed(isValid);
        return;
      }

      // Multi-user mode checks
      const localUser = localStorage.getItem(AUTH_USER);
      const localAuthToken = localStorage.getItem(AUTH_TOKEN);
      if (!localUser || !localAuthToken) {
        setIsAuthed(false);
        return;
      }

      const isValid = await validateSessionTokenForUser();
      if (!isValid) {
        localStorage.removeItem(AUTH_USER);
        localStorage.removeItem(AUTH_TOKEN);
        localStorage.removeItem(AUTH_TIMESTAMP);
        setIsAuthed(false);
        return;
      }

      setIsAuthed(true);
    };
    validateSession();
  }, []);

  return { isAuthd, shouldRedirectToOnboarding, multiUserMode };
}

// Allows only admin to access the route and if in single user mode,
// allows all users to access the route
export function AdminRoute({ Component, hideUserMenu = false }) {
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  const { can, loading: capabilitiesLoading } = useCapabilities();
  if (isAuthd === null) return <FullScreenLoader />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  const user = userFromStorage();
  // #40 task 4: `|| !multiUserMode` is untouched — a single-user deployment has
  // no principal and an empty map, and gating it on a capability would lock it
  // out of its own settings. `loading` is checked so the route does not bounce
  // to home before the answer arrives: a redirect, unlike a hidden button, is
  // not recoverable by waiting.
  // Reachable only if the session check settles BEFORE the capability map:
  // `isAuthd === null` above holds the route through most of the window, so
  // removing this line reds nothing today. It is kept because the two are
  // independent async sources and neither orders the other — a slower
  // /my-capabilities, or a cached session, puts this on the critical path.
  // Deliberately unguarded by a test: reproducing the ordering would mean
  // driving useIsAuthenticated's internals, which would test the mock.
  if (multiUserMode && capabilitiesLoading) return <FullScreenLoader />;
  return isAuthd && (can("settings.write") || !multiUserMode) ? (
    hideUserMenu ? (
      <KeyboardShortcutWrapper>
        <Component />
      </KeyboardShortcutWrapper>
    ) : (
      <KeyboardShortcutWrapper>
        <UserMenu>
          <Component />
        </UserMenu>
      </KeyboardShortcutWrapper>
    )
  ) : (
    <Navigate to={paths.home()} />
  );
}

// Allows manager and admin to access the route and if in single user mode,
// allows all users to access the route
export function ManagerRoute({ Component }) {
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  const { can, loading: capabilitiesLoading } = useCapabilities();
  if (isAuthd === null) return <FullScreenLoader />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  const user = userFromStorage();
  // #40 task 4: ManagerRoute guards the user-administration pages, which the
  // server gates on user.manage (admin.js:81,120,164,215). Not the same
  // capability as AdminRoute's — the role check collapsed them into one
  // spelling of "not default", which is why a principal granted one and not the
  // other got the wrong answer for at least one route.
  // Reachable only if the session check settles BEFORE the capability map:
  // `isAuthd === null` above holds the route through most of the window, so
  // removing this line reds nothing today. It is kept because the two are
  // independent async sources and neither orders the other — a slower
  // /my-capabilities, or a cached session, puts this on the critical path.
  // Deliberately unguarded by a test: reproducing the ordering would mean
  // driving useIsAuthenticated's internals, which would test the mock.
  if (multiUserMode && capabilitiesLoading) return <FullScreenLoader />;
  return isAuthd && (can("user.manage") || !multiUserMode) ? (
    <KeyboardShortcutWrapper>
      <UserMenu>
        <Component />
      </UserMenu>
    </KeyboardShortcutWrapper>
  ) : (
    <Navigate to={paths.home()} />
  );
}

// Allows access only in single user mode — redirects to home in multi-user mode
export function SingleUserRoute({ Component }) {
  const { isAuthd, shouldRedirectToOnboarding, multiUserMode } =
    useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to={paths.onboarding.home()} />;
  }

  return isAuthd && !multiUserMode ? (
    <KeyboardShortcutWrapper>
      <Component />
    </KeyboardShortcutWrapper>
  ) : (
    <Navigate to={paths.home()} />
  );
}

export default function PrivateRoute({ Component }) {
  const { isAuthd, shouldRedirectToOnboarding } = useIsAuthenticated();
  if (isAuthd === null) return <FullScreenLoader />;

  if (shouldRedirectToOnboarding) {
    return <Navigate to="/onboarding" />;
  }

  return isAuthd ? (
    <KeyboardShortcutWrapper>
      <UserMenu>
        <Component />
      </UserMenu>
    </KeyboardShortcutWrapper>
  ) : (
    <Navigate to={paths.login(true)} />
  );
}
