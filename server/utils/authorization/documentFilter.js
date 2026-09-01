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

// seam 07: an allow-list is for small explicit scopes (embed keys), never an org-wide
// IN-list. Over the cap the filter degrades to match-none rather than truncating.
const ALLOWED_DOCUMENT_ID_CAP = 500;
// A deny list is inlined into the provider query, so it needs a bound of its own: an
// org with thousands of hidden documents would otherwise build an unbounded predicate.
// Past the bound the filter fails closed rather than dropping exclusions (B3, QA-1).
const DENIED_DOCUMENT_ID_CAP = 1000;
// Marker for "every workspace in the org" — a service principal holding an org-wide
// grant has no membership rows to enumerate.
const ORG_WIDE_SCOPE = "*";
const FILTERABLE_ACTIONS = new Set(["document.read", "document.search"]);

const matchNoneFilter = ({ actor, policyVersion }) => ({
  orgId: actor?.orgId ?? 1,
  principalType: actor?.type ?? null,
  actorId: actor ? String(actor.id) : null,
  workspaceIds: [],
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
    const policyVersion = head?.version ?? 0n;

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
    const groupIds =
      actor.type === "user"
        ? (
            await tx.group_members.findMany({
              where: { user_id: Number(actor.id) },
              select: { group_id: true },
            })
          ).map((row) => String(row.group_id))
        : [];

    const workspaceIds = await readableWorkspaceIds(tx, actor, action);

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
          `[authorization] allowedDocumentIds over cap (${allowedDocumentIds.length} > ${ALLOWED_DOCUMENT_ID_CAP}) — filter degraded to match-none`
        );
        return matchNoneFilter({ actor, policyVersion });
      }
      boundedAllowList = allowedDocumentIds.map(String);
    }

    const hasScope = workspaceIds.length > 0 || (boundedAllowList?.length ?? 0) > 0;
    if (!hasScope) return matchNoneFilter({ actor, policyVersion });

    // Fail closed rather than ship a filter that silently omits exclusions (B3).
    if (deniedDocumentIds.size > DENIED_DOCUMENT_ID_CAP) {
      console.error(
        `[authorization] deniedDocumentIds over cap (${deniedDocumentIds.size} > ${DENIED_DOCUMENT_ID_CAP}) — filter degraded to match-none`
      );
      return matchNoneFilter({ actor, policyVersion });
    }

    return {
      orgId: actor.orgId ?? 1,
      principalType: actor.type,
      actorId: String(actor.id),
      workspaceIds,
      deniedDocumentIds: [...deniedDocumentIds],
      attributes: { groupIds },
      ...(boundedAllowList ? { allowedDocumentIds: boundedAllowList } : {}),
      matchNone: false,
      policyVersion,
    };
  });
}

/** Workspaces where the actor holds the read/search action, via role grants. */
async function readableWorkspaceIds(tx, actor, action) {
  const permission = await tx.permissions.findUnique({ where: { action } });
  if (!permission) return [];

  const grants = await tx.principal_role_grants.findMany({
    where: {
      orgId: actor.orgId ?? 1,
      principal_type: actor.type,
      principal_id: String(actor.id),
      OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
    },
    select: { role_id: true, workspace_id: true },
  });
  if (grants.length === 0) return [];

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
    // NaN and take down single-user deployments entirely (B1, QA-1).
    if (actor.type === "user") {
      const memberships = await tx.workspace_users.findMany({
        where: { user_id: Number(actor.id) },
        select: { workspace_id: true },
      });
      for (const m of memberships) ids.add(String(m.workspace_id));
    }
    for (const g of scoped) if (g.workspace_id !== null) ids.add(String(g.workspace_id));
    // actor.workspaceIds is deliberately NOT folded in: scope must come from grants and
    // membership rows, never from the Actor object, or a caller that can shape an Actor
    // widens its own reach without a grant check (QA-1 item 4).
    // An org-wide grant is org-wide: a service principal that holds one is not limited
    // to an enumerated list, so it reads as a whole-org scope rather than an empty one.
    if (actor.type !== "user" && ids.size === 0) ids.add(ORG_WIDE_SCOPE);
    return [...ids];
  }
  return [...new Set(scoped.filter((g) => g.workspace_id !== null).map((g) => String(g.workspace_id)))];
}

module.exports = { buildDocumentFilter, ALLOWED_DOCUMENT_ID_CAP };
