/**
 * #126 — the "no workspaces assigned" decision, extracted so it can be
 * rendered.
 *
 * The rule is unchanged from #40 task 4: a caller with no workspace who CAN
 * create one is not stranded, they simply have not made one yet — showing them
 * the dead end hides the control that would fix it. So `!workspace` stays as a
 * condition in its own right and only the second half asks a capability.
 *
 * It lives here rather than inline in Home because Home mounts the entire chat
 * surface: a test that rendered it would fail for twenty unrelated reasons, and
 * the test that stood in for one transcribed the gate's source instead of
 * exercising it. A source assertion catches a deliberate edit but not drift,
 * and goes stale in silence.
 *
 * The decision arrives entirely as props — nothing here reads a hook or a
 * context — so a test mounts it with no app tree behind it.
 *
 * @param {{workspace: object|null, user: object|null, canCreate: boolean,
 *          loading: boolean, fallback: React.ReactNode,
 *          children: React.ReactNode}} props
 */
export default function WorkspaceGate({
  workspace,
  user,
  canCreate,
  loading,
  fallback,
  children,
}) {
  // `!user` is single-user mode: no principal, empty map. It short-circuits
  // before `loading`, so a single-user deployment never renders the loading
  // state and cannot flash.
  //
  // `loading ||` is redundant against canCreate as the caller computes it today
  // (an empty map answers false) and is kept as an independent defence — the
  // hook's side of that contract is held by hooks/useCapabilities.test.jsx.
  if (!workspace && user && (loading || !canCreate)) return fallback;
  return children;
}
