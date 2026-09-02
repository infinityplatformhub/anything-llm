// T-7 (#31): "who can see this document, and why" — the reverse of the engine's
// forward question.
//
// This is what the dual index on `document_acl` exists for (T-1): the engine
// reads by principal, this reads by document. Without the second index the
// answer would be a table scan, which is why it is a schema decision rather
// than a query trick.
//
// Two rules shape it:
//   1. It is DIAGNOSTIC, never a gate. It reports what the policy store says;
//      the engine remains the only thing that decides anything.
//   2. It fails closed on a moving target. If the policy version changes while
//      the answer is being assembled, a partial list would be presented as
//      complete — worse than no answer, because a support engineer would act
//      on it (S-19).

const prisma = require("../prisma");
const {
  AuthorizationContractError,
  AuthorizationUnavailableError,
} = require("./errors");

/**
 * @param {{documentId: number, action?: string, db?: Object}} input
 * @returns {Promise<{documentId:number, action:string, policyVersion:string, hidden:boolean, principals:Array<Object>}>}
 */
async function explainDocumentAccess({
  documentId,
  action = "document.read",
  db = prisma,
}) {
  if (!Number.isInteger(documentId)) {
    throw new AuthorizationContractError("documentId must be an integer");
  }

  const head = async () =>
    (
      await db.policy_versions.findFirst({
        orderBy: { version: "desc" },
        select: { version: true },
      })
    )?.version ?? 0n;

  const before = await head();

  const document = await db.documents.findUnique({
    where: { id: documentId },
    select: { id: true, filename: true },
  });
  // The caller's right to know the document exists was decided by the route's
  // access.diagnose gate, not here (S-18).
  if (!document) return null;

  const visibility = await db.document_visibility.findUnique({
    where: { document_id: documentId },
    select: { hidden: true },
  });

  const aclRows = await db.document_acl.findMany({
    where: { document_id: documentId, action },
    select: {
      principal_type: true,
      principal_id: true,
      effect: true,
      source: true,
    },
  });

  const principals = [];
  for (const row of aclRows) {
    const entry = {
      principalType: row.principal_type,
      principalId: row.principal_id,
      effect: row.effect,
      // Why they have it, in the store's own words: an inherited workspace
      // grant and a hand-made one look identical without this.
      via: row.source,
      members: undefined,
    };

    // A group grant is not an answer on its own — "the finance group may read
    // it" does not tell a support engineer whether the person complaining is in
    // finance.
    if (row.principal_type === "group") {
      const members = await db.group_members.findMany({
        where: { group_id: Number(row.principal_id) },
        select: { user_id: true },
      });
      entry.members = members.map((m) => String(m.user_id));
    }

    principals.push(entry);
  }

  const after = await head();
  if (after !== before) {
    // S-19: a grant changed underneath us. Returning what we gathered would
    // present a partial list as complete.
    throw new AuthorizationUnavailableError(
      "policy changed while explaining access — retry for a consistent answer"
    );
  }

  return {
    documentId: document.id,
    filename: document.filename,
    action,
    // String, not BigInt: this is serialised to JSON by the diagnostics route.
    policyVersion: String(before),
    hidden: visibility?.hidden === true,
    // Deny wins in the engine, so surface denies first — a reader scanning the
    // list should meet the reason for refusal before the reasons for access.
    principals: principals.sort((a, b) =>
      a.effect === b.effect ? 0 : a.effect === "deny" ? -1 : 1
    ),
  };
}

module.exports = { explainDocumentAccess };
