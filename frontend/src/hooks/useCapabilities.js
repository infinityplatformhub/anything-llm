import { useEffect, useState } from "react";
import System from "@/models/system";

/**
 * #40 task 3: what THIS caller may do, for gating affordances.
 *
 * Session-cached in a module-level promise, deliberately not localStorage. The
 * comment at `models/system.js` on fetchCanViewChatHistory has the reason: a
 * grant an admin can revoke at any moment must not outlive the tab, or the UI
 * keeps offering a feature the server has already started refusing. A promise
 * also collapses the concurrent mount storm — 21 call sites (task 4) would
 * otherwise each fire their own request on first paint.
 */
let capabilitiesPromise = null;

function loadCapabilities() {
  if (!capabilitiesPromise) {
    capabilitiesPromise = System.fetchMyCapabilities();
    // Drop a rejected promise so the next reader retries. A cached rejection
    // would answer every later mount with the same failure, leaving can()
    // false for the whole tab until a manual reload — a transient network
    // blip would look exactly like a revoked grant.
    capabilitiesPromise.catch(() => {
      capabilitiesPromise = null;
    });
  }
  return capabilitiesPromise;
}

/**
 * Drops the cached answer so the next reader refetches. Call after anything
 * that changes the caller's own grants (role change, view-as, sign-out).
 */
export function resetCapabilities() {
  capabilitiesPromise = null;
}

/**
 * @returns {{can: (action: string) => boolean, loading: boolean, error: string|null}}
 *
 * `can(action)` answers false while loading, which is the safe direction for a
 * gate but NOT a usable answer on its own: "not yet known" and "denied" are the
 * same value, and a component that renders straight off `can()` shows a
 * hidden-looking UI that then pops. Read `loading` and render the skeleton the
 * mockup specifies for that state — the two are not interchangeable.
 */
export default function useCapabilities() {
  const [state, setState] = useState({
    capabilities: {},
    loading: true,
    error: null,
  });

  useEffect(() => {
    let live = true;
    loadCapabilities()
      .then(({ capabilities, error }) => {
        if (!live) return;
        setState({ capabilities, loading: false, error });
      })
      // fetchMyCapabilities catches its own failures, so this is the last
      // resort. Without it a rejection leaves loading true forever and the
      // component sits on a skeleton that never resolves — worse than a denial,
      // which at least renders.
      .catch(() => {
        if (!live) return;
        setState({ capabilities: {}, loading: false, error: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, []);

  // Strict equality, not truthiness: the server answers present-and-false for a
  // denied capability and omits nothing, so an undefined here means the map
  // never arrived — which must read as denied, not as an error to throw on.
  const can = (action) => state.capabilities[action] === true;
  return { can, loading: state.loading, error: state.error };
}

/**
 * The same question about one workspace. Not cached: the answer is per
 * workspace, and a stale map here would gate the wrong workspace's controls.
 *
 * `workspace` is null whenever the caller cannot see it — a workspace that does
 * not exist and one belonging to someone else answer identically, on purpose.
 *
 * @param {string|number|null} workspaceId
 * @returns {{can: (action: string) => boolean, visible: boolean, loading: boolean, error: string|null}}
 */
export function useWorkspaceCapabilities(workspaceId) {
  const [state, setState] = useState({
    workspace: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let live = true;
    if (workspaceId === undefined || workspaceId === null) {
      setState({ workspace: null, loading: false, error: null });
      return () => {};
    }
    setState((prior) => ({ ...prior, loading: true }));
    System.fetchMyCapabilities({ workspaceId })
      .then(({ workspace, error }) => {
        if (!live) return;
        setState({ workspace, loading: false, error });
      })
      .catch(() => {
        if (!live) return;
        setState({ workspace: null, loading: false, error: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const can = (action) => state.workspace?.capabilities?.[action] === true;
  return {
    can,
    // Distinct from `can(...) === false` everywhere: null means the caller
    // cannot see this workspace at all, which is a different thing to show than
    // a workspace whose controls are merely disabled.
    visible: state.workspace !== null,
    loading: state.loading,
    error: state.error,
  };
}
