// #96: the ONE place that answers "which groups does this principal belong to".
//
// Group membership is read on three paths — the engine's grant lookup, the ALLOW
// half of documentFilter's readable scope, and its DENY half. Before this, the
// first two read no membership at all (a role granted to a group authorized
// nobody) and the third had its own inline copy keyed on the wrong field. One
// function, called from all three: three expansions free to drift apart is the
// defect this issue exists to remove, one release later.
//
// NOT in `principals.js`, though the ruling named it. That file exists precisely
// because it requires NOTHING — hotfix #39, where actorResolver → systemSettings →
// user → legacyRoleGrants → actorResolver handed callers a half-built exports
// object and new workspace members silently never received their grant. This
// helper takes a db handle, so filing it there would rebuild the cycle #39 was
// written to remove. Its own file, requiring nothing but what callers pass in.
//
// `explainAccess` deliberately does NOT use this. It asks the reverse question —
// given a grant row, who does it cover — and expands a named group to its members
// rather than a member to their groups.

/**
 * Group ids a principal belongs to, within one org.
 *
 * @param {{type:string, id:string|number}|null} principal the principal whose grants
 *   are being read. NOT an Actor: an api-key Actor evaluates as its creator, and each
 *   caller decides whether that creator's groups apply (the engine says they do not).
 * @param {number} orgId org the decision is being made in
 * @param {Object} db prisma client or transaction
 * @returns {Promise<string[]>} group ids as strings, matching `principal_id`'s type
 */
async function groupIdsFor(principal, orgId, db, memo = null) {
  // Only a user has membership: `group_members.user_id` is an FK to `users`.
  // Service, embed and system principals carry non-numeric ids ("core-jobs"), so
  // this guard is what stops `Number(id)` becoming NaN — which Prisma rejects at
  // runtime, turning a decision that should fail closed into a thrown error.
  if (!principal || principal.type !== "user") return [];
  const userId = Number(principal.id);
  if (!Number.isInteger(userId)) return [];

  // Membership is a property of the principal, not of the resource being asked
  // about, so a batch reads it once. The memo is supplied per CALL (authorizeMany
  // makes one and drops it); nothing here caches across calls, because a cache
  // that outlived the request would let a removed member keep their access.
  //
  // The memo holds the PROMISE, not the resolved array. authorizeMany fans out
  // with Promise.all, so all 100 decisions start before any of them finishes —
  // caching the result would have every one of them miss and issue its own query,
  // which is the 100× this exists to prevent. Storing the in-flight promise makes
  // the other 99 await the first.
  const memoKey = memo && `${orgId}:${userId}`;
  if (memo && memo.has(memoKey)) return memo.get(memoKey);

  // The org filter goes through the `groups` relation, because `group_members` has
  // no orgId column of its own. Without it, a grant row written as
  // {orgId: 1, principal: group:2} matches a user whose group 2 lives in org 2 —
  // the grant's orgId is the only one the callers check, and it is not the group's.
  const pending = db.group_members
    .findMany({
      where: { user_id: userId, groups: { orgId } },
      select: { group_id: true },
    })
    .then((rows) => rows.map((row) => String(row.group_id)));

  // Stored BEFORE the await, so callers that start while this query is in flight
  // find it. A failed query removes itself rather than caching a rejection for the
  // rest of the batch — the next caller retries and, if it fails too, the error
  // surfaces as unavailable, which is what fails closed.
  if (memo) {
    memo.set(memoKey, pending);
    pending.catch(() => memo.delete(memoKey));
  }
  return pending;
}

/**
 * The `principal_role_grants` principal filter: the principal itself plus its
 * groups. Shared so the engine and readableScope build the same OR clause and
 * cannot answer differently about who a user is.
 *
 * @returns {Promise<Array<{principal_type:string, principal_id:string}>>}
 */
async function grantPrincipalPairs(principal, orgId, db, memo = null) {
  const pairs = [
    { principal_type: principal.type, principal_id: String(principal.id) },
  ];
  for (const groupId of await groupIdsFor(principal, orgId, db, memo))
    pairs.push({ principal_type: "group", principal_id: groupId });
  return pairs;
}

module.exports = { groupIdsFor, grantPrincipalPairs };
