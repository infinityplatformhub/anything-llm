// T-5 (#30) slice 2 (G17/S-21): the one bridge every pinned-document call site uses.
//
// Ten call sites fetch pinned documents. If each built its own filter, wiring would be ten
// copies of a two-step sequence, and the failure mode of a copied sequence is that one copy
// is missing a step and nothing says so — which is precisely how this path came to bypass
// the ACL in the first place.
//
// `document.read`, not `document.search`. A pinned document is not retrieved by a query;
// it is injected into the prompt wholesale. Asking for `document.search` would consult a
// different set of ACL rows and silently miss a read-deny — the filter would look present
// and enforce the wrong question.

const { retrievalFilterFor } = require("./retrievalFilter");

/**
 * Fetch the pinned documents this actor may READ.
 *
 * @param {Object} input
 * @param {Object} input.workspace
 * @param {number} [input.maxTokens] token cap for prepended content
 * @param {Object|null} [input.user] the requesting user, when there is one
 * @param {Object|null} [input.actor] a resolved Actor, when the caller has one
 * @param {Object|null} [input.actorRef] a principal reference to resolve
 * @param {Object} [input.db]
 * @returns {Promise<Object[]>}
 */
async function authorizedPinnedDocs({
  workspace,
  maxTokens = null,
  user = null,
  actor = null,
  actorRef = null,
  db = undefined,
}) {
  const { DocumentManager } = require("../DocumentManager");
  const aclFilter = await retrievalFilterFor({
    user,
    actor,
    actorRef,
    action: "document.read",
    db,
  });
  return new DocumentManager({ workspace, maxTokens }).pinnedDocs({
    aclFilter,
    db,
  });
}

module.exports = { authorizedPinnedDocs };
