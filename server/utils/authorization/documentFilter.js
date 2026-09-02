// T-3 (#22): documentFilter — builds the seam-02 DocumentAclFilter that seam 07 drivers
// push down into the provider query. The filter is the ONLY thing a vector driver is
// allowed to enforce with; callers never post-filter results (seam 07 boundary).
//
// Build order is binding (recon .infi/recon/t3-document-filter.md §1):
//   1. no actor / empty scope -> match-none (a valid filter object, never null)
//   2. visibility FIRST as a hard override — hidden documents are denied before any ACL
//      row is read, so no grant can ever re-allow them
//   3. ACL: principals = user + groups + workspaces the actor may read in; deny wins
//   4. allowedDocumentIds only for embed/service actors, capped
//   5. policyVersion read in the same snapshot as the rows it describes

const prisma = require("../prisma");
const { AuthorizationContractError } = require("./errors");
const { groupIdsFor, grantPrincipalPairs } = require("./groupMembership");

// seam 07: an allow-list is for small explicit scopes (embed keys), never an org-wide
// IN-list. Over the cap the filter degrades to match-none rather than truncating.
const ALLOWED_DOCUMENT_ID_CAP = 500;
// A deny list is inlined into the provider query, so it needs a bound of its own: an
// org with thousands of hidden documents would otherwise build an unbounded predicate.
// Past the bound the filter fails closed rather than dropping exclusions (B3, QA-1).
const DENIED_DOCUMENT_ID_CAP = 1000;
const FILTERABLE_ACTIONS = new Set(["document.read", "document.search"]);

const matchNoneFilter = ({ actor, policyVersion }) => ({
  orgId: actor?.orgId ?? 1,
  principalType: actor?.type ?? null,
  actorId: actor ? String(actor.id) : null,
  workspaceIds: [],
  orgWide: false,
  deniedDocumentIds: [],
  attributes: {},
  matchNone: true,
  policyVersion,
});

/**
 * @param {{actor: Object|null, action: string, db?: Object, allowedDocumentIds?: string[]}} input
 * @returns {Promise<Object>} DocumentAclFilter — never null, never unfiltered
 */
async function buildDocumentFilter({ actor, action, db = prisma, allowedDocumentIds }) {
  if (!FILTERABLE_ACTIONS.has(action)) {
    throw new AuthorizationContractError(
      `documentFilter supports ${[...FILTERABLE_ACTIONS].join("/")}, got: ${action}`
    );
  }

  // One snapshot: the version must describe the rows read below, so it is read first
  // inside the same transaction and never re-fetched afterwards.
  return db.$transaction(async (tx) => {
    const head = await tx.policy_versions.findFirst({
      orderBy: { version: "desc" },
      select: { version: true },
    });
    // Stamped as a string at build time, not at serialize time: a BigInt in the filter
    // makes JSON.stringify throw, which would 500 every route that echoes it once T-4
    // wires the filter into HTTP paths (QA-2 item 7).
    const policyVersion = String(head?.version ?? 0n);

    if (!actor || !actor.type || !actor.id) return matchNoneFilter({ actor, policyVersion });

    // ---- step 2: visibility, hard override, before any ACL evaluation ----
    // Scoped by org through the document relation (document_visibility has no orgId of
    // its own): another org's hidden ids must never enter this filter (B3, QA-1).
    const orgId = actor.orgId ?? 1;
    const hidden = await tx.document_visibility.findMany({
      where: { hidden: true, documents: { orgId } },
      select: { document_id: true },
    });
    const deniedDocumentIds = new Set(hidden.map((row) => String(row.document_id)));

    // ---- step 3: principals the actor evaluates as ----
    // #96: was an inline expansion keyed on `actor.id` and unfiltered by org. Both
    // were wrong in ways that only showed on the DENY side: an api-key actor
    // (`actor.id` = "api-key:7") matched no membership, so a deny row aimed at the
    // creator's group never reached a key acting for them; and a group in another
    // org could contribute a deny here. Now the same helper, org-filtered.
    //
    // This is the DENY side of the invariant stated at `readableScope`: an api-key
    // IS expanded through its creator here, precisely because widening a denial
    // cannot grant anything. The allow side does not expand it — that would hand
    // the key authority nobody reviewed.
    const denyPrincipal =
      "grantPrincipal" in actor ? actor.grantPrincipal : actor;
    const groupIds = await groupIdsFor(denyPrincipal, orgId, tx);

    const { workspaceIds, orgWide } = await readableScope(tx, actor, action);

    // explicit deny rows for any principal this actor evaluates as
    const principalPairs = [
      { principal_type: actor.type, principal_id: String(actor.id) },
      ...groupIds.map((id) => ({ principal_type: "group", principal_id: id })),
      ...workspaceIds.map((id) => ({ principal_type: "workspace", principal_id: id })),
    ];
    const denies = await tx.document_acl.findMany({
      where: { orgId, action, effect: "deny", OR: principalPairs },
      select: { document_id: true },
    });
    for (const row of denies) deniedDocumentIds.add(String(row.document_id));

    // ---- step 4: bounded allow list, embed/service only ----
    let boundedAllowList;
    if (allowedDocumentIds !== undefined) {
      if (actor.type !== "embed" && actor.type !== "service") {
        throw new AuthorizationContractError(
          "allowedDocumentIds is reserved for embed/service actors"
        );
      }
      if (allowedDocumentIds.length > ALLOWED_DOCUMENT_ID_CAP) {
        // Never truncate: a short list would silently widen or narrow access.
        console.error(
          `[authorization] allowedDocumentIds over cap (${allowedDocumentIds.length} > ${ALLOWED_DOCUMENT_ID_CAP}) for ${actor.type}:${actor.id} — filter degraded to match-none`
        );
        return matchNoneFilter({ actor, policyVersion });
      }
      boundedAllowList = allowedDocumentIds.map(String);
    }

    // orgWide counts as scope on its own: a service principal holding an org-wide grant
    // has no membership rows to enumerate, so an empty workspaceIds is not an empty scope
    // for it. Omitting it here re-opens B1 in a new shape (single-user reads nothing).
    const hasScope =
      orgWide || workspaceIds.length > 0 || (boundedAllowList?.length ?? 0) > 0;
    if (!hasScope) return matchNoneFilter({ actor, policyVersion });

    // Fail closed rather than ship a filter that silently omits exclusions (B3).
    if (deniedDocumentIds.size > DENIED_DOCUMENT_ID_CAP) {
      console.error(
        `[authorization] deniedDocumentIds over cap (${deniedDocumentIds.size} > ${DENIED_DOCUMENT_ID_CAP}) for ${actor.type}:${actor.id} — filter degraded to match-none`
      );
      return matchNoneFilter({ actor, policyVersion });
    }

    return {
      orgId: actor.orgId ?? 1,
      principalType: actor.type,
      actorId: String(actor.id),
      workspaceIds,
      orgWide,
      deniedDocumentIds: [...deniedDocumentIds],
      attributes: { groupIds },
      ...(boundedAllowList ? { allowedDocumentIds: boundedAllowList } : {}),
      matchNone: false,
      policyVersion,
    };
  });
}

/**
 * Scope where the actor holds the read/search action, via role grants.
 * @returns {Promise<{workspaceIds: string[], orgWide: boolean}>} `orgWide` is a separate
 *   field rather than a sentinel inside `workspaceIds`: seam 07 pushes that array into
 *   the provider query, where a `"*"` entry would be looked up as a namespace name.
 */
async function readableScope(tx, actor, action) {
  const empty = { workspaceIds: [], orgWide: false };
  const permission = await tx.permissions.findUnique({ where: { action } });
  if (!permission) return empty;

  // T-4b (#29) B-1: an API-key Actor holds no grants under `api-key:<id>`; it reads as its
  // creator. The engine applies the same rule, so a key that may call a route also sees the
  // documents that route returns instead of an empty filter.
  const grantPrincipal =
    "grantPrincipal" in actor ? actor.grantPrincipal : actor;
  if (!grantPrincipal) return empty;

  // #96: the ALLOW half read grants for the principal alone, exactly as the engine
  // did. Fixing only the engine would have been WORSE than leaving both: authorize()
  // would permit a read that this filter then answered with nothing, which reads as
  // an empty workspace rather than as a refusal. Same helper as the engine, so the
  // two cannot answer differently about who a user is.
  //
  // THE INVARIANT, stated once and true of all three read paths: group expansion
  // widens what a key is DENIED, and never widens what it is ALLOWED. So an
  // api-key is not expanded here or in the engine — its authority stays what its
  // creator holds directly, rather than growing whenever someone edits a group —
  // while the deny half below DOES expand it, so a prohibition aimed at the
  // creator's department cannot be sidestepped by acting through a key.
  const orgId = actor.orgId ?? 1;
  const principalPairs =
    "grantPrincipal" in actor
      ? [
          {
            principal_type: grantPrincipal.type,
            principal_id: String(grantPrincipal.id),
          },
        ]
      : await grantPrincipalPairs(grantPrincipal, orgId, tx);

  const grants = await tx.principal_role_grants.findMany({
    where: {
      AND: [
        {
          orgId,
          OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
        },
        { OR: principalPairs },
      ],
    },
    select: { role_id: true, workspace_id: true },
  });
  if (grants.length === 0) return empty;

  const rows = await tx.role_permissions.findMany({
    where: {
      role_id: { in: grants.map((g) => g.role_id) },
      permission_id: permission.id,
      effect: "allow",
    },
    select: { role_id: true },
  });
  const rolesWithAction = new Set(rows.map((r) => r.role_id));

  const scoped = grants.filter((g) => rolesWithAction.has(g.role_id));
  const orgWide = scoped.some((g) => g.workspace_id === null);
  if (orgWide) {
    const ids = new Set();
    // Membership only exists for real user rows. A service/embed principal has a
    // non-numeric id (`single-user`, `api-key:7`), so coercing it would hand Prisma a
    // NaN and take down single-user deployments entirely (B1, QA-1). The check is on the
    // GRANT principal, not the Actor: a key acting for a user must enumerate that user's
    // memberships rather than fall through to a whole-org read (T-4b B-1).
    if (grantPrincipal.type === "user") {
      const memberships = await tx.workspace_users.findMany({
        where: { user_id: Number(grantPrincipal.id) },
        select: { workspace_id: true },
      });
      for (const m of memberships) ids.add(String(m.workspace_id));
    }
    for (const g of scoped) if (g.workspace_id !== null) ids.add(String(g.workspace_id));
    // actor.workspaceIds is deliberately NOT folded in: scope must come from grants and
    // membership rows, never from the Actor object, or a caller that can shape an Actor
    // widens its own reach without a grant check (QA-1 item 4).
    //
    // A user's org-wide grant still resolves to that user's enumerated memberships — the
    // grant says "in any workspace you are in", not "in every workspace". Only a service
    // or embed principal, which has no membership rows at all, reads as whole-org.
    return narrowToKeyBinding(actor, {
      workspaceIds: [...ids],
      orgWide: grantPrincipal.type !== "user",
    });
  }
  return narrowToKeyBinding(actor, {
    workspaceIds: [
      ...new Set(scoped.filter((g) => g.workspace_id !== null).map((g) => String(g.workspace_id))),
    ],
    orgWide: false,
  });
}

/**
 * A workspace-bound API key may only ever NARROW its creator's reach. The binding comes
 * from the key row (`api_keys.workspaceId`), not from anything a caller can shape, so
 * intersecting with it cannot widen scope — the worst a forged binding achieves is a
 * smaller result set. Unbound keys and every other actor pass through untouched.
 */
function narrowToKeyBinding(actor, scope) {
  const binding = actor.keyWorkspaceBinding;
  if (!Array.isArray(binding) || binding.length === 0) return scope;
  const allowed = new Set(binding.map(String));
  return {
    // An org-wide grant narrowed by a binding is exactly the bound workspaces.
    workspaceIds: scope.orgWide
      ? [...allowed]
      : scope.workspaceIds.filter((id) => allowed.has(id)),
    orgWide: false,
  };
}

module.exports = { buildDocumentFilter, ALLOWED_DOCUMENT_ID_CAP };
