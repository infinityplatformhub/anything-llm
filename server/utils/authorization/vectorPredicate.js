// T-5 (#30): translate a seam-02 DocumentAclFilter into a provider predicate, and enforce
// the same rules again on the rows that come back.
//
// Lives here rather than in a provider because eight providers must agree on what a filter
// MEANS. If each wrote its own translation, "denied" would drift into eight slightly
// different answers and only the strictest would be right.
//
// Two layers, deliberately overlapping:
//
//   1. `predicateFor` — the pushdown. This is the real enforcement: it runs inside the
//      query, before topN, so the actor's own documents compete for the topN slots
//      instead of losing them to rows they may not read (S-17).
//   2. `isRowAllowed` — a check on returned rows. Redundant when the pushdown works, and
//      that is the point: a provider whose predicate is subtly wrong (an unindexed column
//      silently ignored, a dialect quirk) fails closed instead of leaking. It also catches
//      rows written before the ACL backfill, which no predicate can match (S-26/G4).

const { AuthorizationContractError } = require("./errors");

/** SQL string literal escaping — single quotes doubled, the one metacharacter that matters. */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * A filter must be a filter. Null, `{}`, or a filter with no policy stamp are all refused
 * rather than treated as "no restriction" — an unfiltered read must never be reachable by
 * forgetting an argument.
 */
function assertFilter(aclFilter) {
  if (!aclFilter || typeof aclFilter !== "object") {
    throw new AuthorizationContractError(
      "queryAuthorized requires a DocumentAclFilter — null is never 'no restriction'"
    );
  }
  if (aclFilter.policyVersion === undefined || aclFilter.policyVersion === null) {
    throw new AuthorizationContractError(
      "DocumentAclFilter is missing policyVersion — an unstamped filter cannot be known to describe current policy"
    );
  }
  if (aclFilter.matchNone !== true && aclFilter.orgId === undefined) {
    throw new AuthorizationContractError(
      "DocumentAclFilter is missing orgId"
    );
  }
}

/**
 * Build the SQL-ish predicate a provider pushes into its query.
 *
 * Returns null for a match-none filter: the caller must skip the query entirely rather
 * than issue one with an unsatisfiable predicate. Cheaper, and impossible to get subtly
 * wrong in a dialect that treats `1=0` unusually.
 */
function predicateFor(aclFilter) {
  assertFilter(aclFilter);
  if (aclFilter.matchNone === true) return null;

  const clauses = [`orgId = ${quote(aclFilter.orgId)}`];

  // orgWide is scope on its own: a service principal holding an org-wide grant has no
  // membership rows to enumerate, so an empty workspaceIds is not an empty scope for it.
  // Narrowing to workspaces here would deny it everything.
  if (!aclFilter.orgWide) {
    const workspaceIds = (aclFilter.workspaceIds ?? []).map(quote);
    if (workspaceIds.length === 0) return null;
    clauses.push(`workspaceId IN (${workspaceIds.join(", ")})`);
  }

  // Deny wins, and it is inlined rather than applied afterwards for the same reason the
  // whole predicate is: a denied document must not occupy a topN slot.
  const denied = (aclFilter.deniedDocumentIds ?? []).map(quote);
  if (denied.length > 0) clauses.push(`docId NOT IN (${denied.join(", ")})`);

  // An explicit allow-list (embed/service actors) is a further narrowing, never a
  // widening — it is ANDed with everything above.
  if (Array.isArray(aclFilter.allowedDocumentIds)) {
    const allowed = aclFilter.allowedDocumentIds.map(quote);
    if (allowed.length === 0) return null;
    clauses.push(`docId IN (${allowed.join(", ")})`);
  }

  return clauses.join(" AND ");
}

/**
 * Re-check one returned row against the same filter.
 *
 * A row that cannot be PROVEN allowed is denied. Missing orgId or workspaceId means the
 * row predates the ACL backfill: there is no way to tell whose document it is, and
 * "unknown" must not read as "yours".
 */
function isRowAllowed(row, aclFilter) {
  if (!row || typeof row !== "object") return false;
  if (aclFilter.matchNone === true) return false;

  // No metadata, no proof (S-26/G4).
  if (row.orgId === undefined || row.orgId === null) return false;
  if (String(row.orgId) !== String(aclFilter.orgId)) return false;

  if (!aclFilter.orgWide) {
    if (row.workspaceId === undefined || row.workspaceId === null) return false;
    const scope = (aclFilter.workspaceIds ?? []).map(String);
    if (!scope.includes(String(row.workspaceId))) return false;
  }

  const docId = row.docId === undefined || row.docId === null ? null : String(row.docId);
  const denied = (aclFilter.deniedDocumentIds ?? []).map(String);
  // A row with no docId cannot be checked against the deny list. If anything is denied at
  // all, that unverifiable row is refused rather than assumed innocent.
  if (denied.length > 0 && (docId === null || denied.includes(docId))) return false;

  if (Array.isArray(aclFilter.allowedDocumentIds)) {
    const allowed = aclFilter.allowedDocumentIds.map(String);
    if (docId === null || !allowed.includes(docId)) return false;
  }

  return true;
}

module.exports = { assertFilter, predicateFor, isRowAllowed };
