// T-5 (#30): the ACL fields every vector must carry, decided in one place.
//
// The filter (vectorPredicate) reads `orgId`, `workspaceId` and `docId` off each row. If
// the write path and the read path disagree about the NAMES or the TYPES of those fields,
// nothing errors — the predicate simply matches nothing and retrieval quietly returns an
// empty result. That failure looks like a retrieval-quality problem and would be debugged
// as one, so both sides read their field names from here.
//
// Ids are stringified because that is how the filter compares them: `workspaceIds` in a
// DocumentAclFilter is `string[]` (seam 07), and a numeric 3 in the payload would never
// equal the string "3" in the predicate.

const { AuthorizationContractError } = require("./errors");

/**
 * Build the ACL metadata for a vector about to be written.
 *
 * Throws on missing input rather than writing a partial row. A vector with no workspaceId
 * is one the filter can never prove is allowed: it would be silently unreadable forever,
 * with nothing at ingest time to explain why. Write time is the only point where the
 * mistake is still cheap to fix.
 *
 * @param {{workspaceId: number|string, docId: string, orgId?: number|string}} input
 * @returns {{orgId: string, workspaceId: string, docId: string}}
 */
function aclMetadataFor({ workspaceId, docId, orgId = 1 }) {
  if (workspaceId === undefined || workspaceId === null || workspaceId === "") {
    throw new AuthorizationContractError(
      "a vector cannot be written without a workspaceId — the ACL filter could never prove it readable"
    );
  }
  if (docId === undefined || docId === null || docId === "") {
    throw new AuthorizationContractError(
      "a vector cannot be written without a docId — deny-list checks would have nothing to match"
    );
  }
  return {
    orgId: String(orgId),
    workspaceId: String(workspaceId),
    docId: String(docId),
  };
}

/**
 * Resolve the ACL metadata for a write, given only what every provider already has: the
 * namespace (a workspace slug) and the docId.
 *
 * Resolved inside the provider rather than threaded through `addDocumentToNamespace`'s
 * signature, because that method is called from five places (documents model, embedding
 * worker, two sync-watched paths, agent memory) and an argument five callers must
 * remember is an argument one of them will eventually forget — silently, producing
 * vectors nothing can ever read.
 *
 * Returns null when the workspace cannot be resolved, so the caller writes vectors exactly
 * as it did before rather than failing an upload. That is the conservative choice while
 * RETRIEVAL_FILTER_ENFORCE is off: an unlabelled vector is still readable. Once
 * enforcement is on, such a vector would be unreadable — which is why this logs loudly.
 *
 * @param {{namespace: string, docId: string, db?: Object}} input
 * @returns {Promise<{orgId: string, workspaceId: string, docId: string}|null>}
 */
async function aclMetadataForNamespace({ namespace, docId, db = null }) {
  const prisma = db ?? require("../prisma");
  try {
    const workspace = await prisma.workspaces.findFirst({
      where: { slug: String(namespace) },
      select: { id: true },
    });
    if (!workspace) {
      console.warn(
        `\x1b[33m[authorization]\x1b[0m no workspace found for namespace "${namespace}" — vectors will be written without ACL metadata and will be unreadable once RETRIEVAL_FILTER_ENFORCE is on.`
      );
      return null;
    }
    return aclMetadataFor({ workspaceId: workspace.id, docId });
  } catch (error) {
    console.warn(
      `\x1b[33m[authorization]\x1b[0m could not resolve ACL metadata for namespace "${namespace}": ${error.message}`
    );
    return null;
  }
}

module.exports = { aclMetadataFor, aclMetadataForNamespace };
