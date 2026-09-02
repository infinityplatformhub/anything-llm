// PR-4d (#35): an API key may not be minted holding more than its creator holds.
//
// PR-4c made every key carry an enumerated list instead of "*", but the list a caller
// could ask for was a preset chosen by which endpoint they hit. Both mint sites are
// admin-gated, so nothing could exceed an admin — #27 recorded that as a ponytail
// rather than a hole, because `setup_admin` already holds `key.manage` and the moment
// any non-admin role gains it, the preset becomes a grant nobody made.
//
// Two questions, deliberately separate:
//   1. May this principal mint a key AT ALL?  -> key.manage
//   2. What may the key it mints hold?        -> every requested scope, one decision each
// Collapsing them would let a bug in (1) hide behind a failure in (2): the seeded
// `member` role holds only chat.send, so a member's request fails either check, and an
// implementation that never asked (1) would still look correct.
//
// Every decision comes from the same engine the HTTP path uses. There is no second
// authorization path here — a scope is a permission action, and the ceiling is the
// creator's own grants read through seam 02.

const { DatabaseAuthorizationEngine } = require("../authorization/engine");
const { keyGrantPrincipal } = require("../authorization/actorResolver");
const { AuthorizationUnavailableError } = require("../authorization/errors");

const KEY_MINT_ACTION = "key.manage";
const ORG_ID = 1;

/** Thrown when the creator may not mint keys at all. Distinct from the ceiling. */
class KeyMintForbiddenError extends Error {}
/** Thrown when the creator may mint, but not with the scopes they asked for. */
class ScopeCeilingError extends Error {}

const orgResource = () => ({
  type: "org",
  id: String(ORG_ID),
  orgId: ORG_ID,
  workspaceId: null,
});

/**
 * The Actor grants are read for, given a key's creator id.
 *
 * `keyGrantPrincipal` is the existing answer and the only one: a null creator resolves
 * to the single-user service principal ONLY when `isConfirmedSingleUser` agrees, so a
 * multi-user deployment with a missing creator denies rather than borrowing super_admin
 * (QA-2 FINDING-1). A second resolution path here would be a second place for that gate
 * to be forgotten.
 */
async function ceilingActor(creatorId, db) {
  const principal = await keyGrantPrincipal(creatorId ?? null, db);
  if (!principal) return null;
  return { ...principal, orgId: ORG_ID };
}

/**
 * Enforces both checks and returns the scope list the key may actually be minted with.
 *
 * @param {object} input
 * @param {number|null} input.creatorId
 * @param {string[]} input.scopes already shape-validated (known, non-empty, no "*")
 * @param {number|null} input.workspaceId when the key is bound to one workspace
 * @param {boolean} input.trimToCeiling true when `scopes` is a DEFAULT the caller never
 *   named. A default is narrowed to what the creator holds; a list the caller wrote is
 *   refused, because someone who asked for a scope deserves an answer about it rather
 *   than a quieter key they find out about at the first 403 (PMO ruling 2).
 * @returns {Promise<string[]>} the granted scopes, in the requested order
 * @throws {KeyMintForbiddenError|ScopeCeilingError|AuthorizationUnavailableError}
 */
async function applyScopeCeiling({
  creatorId = null,
  scopes,
  workspaceId = null,
  trimToCeiling = false,
  db,
  engine = new DatabaseAuthorizationEngine({ db }),
}) {
  const actor = await ceilingActor(creatorId, db);
  if (!actor) {
    throw new KeyMintForbiddenError(
      `No principal holds ${KEY_MINT_ACTION} for this key: its creator cannot be resolved.`
    );
  }

  // (1) Authority to mint. First, and with its own error — see the header.
  const mayMint = await engine.authorize({
    actor,
    action: KEY_MINT_ACTION,
    resource: orgResource(),
  });
  if (!mayMint.allowed) {
    throw new KeyMintForbiddenError(
      `Creating an API key requires ${KEY_MINT_ACTION}, which this principal does not hold.`
    );
  }

  // (2) A bound key reaches one workspace, so its creator must be in that workspace.
  // Membership, not a grant: an org-wide reader is not thereby a member, and the binding
  // is what the engine enforces at request time (`outside_key_binding`).
  if (workspaceId !== null && workspaceId !== undefined) {
    const isMember = await creatorInWorkspace(actor, Number(workspaceId), db);
    if (!isMember) {
      throw new ScopeCeilingError(
        `A key cannot be bound to workspace ${workspaceId}: its creator is not a member of it.`
      );
    }
  }

  // (3) The ceiling itself. One decision per scope, all of them, so the caller learns
  // everything they lack in one round trip instead of one refusal at a time.
  const decisions = await Promise.all(
    scopes.map(async (scope) => ({
      scope,
      allowed: (await engine.authorize({ actor, action: scope, resource: orgResource() }))
        .allowed,
    }))
  );
  const held = decisions.filter((d) => d.allowed).map((d) => d.scope);
  const lacked = decisions.filter((d) => !d.allowed).map((d) => d.scope);

  if (!lacked.length) return [...scopes];

  if (!trimToCeiling) {
    throw new ScopeCeilingError(
      `The creator does not hold: ${lacked.join(", ")}. A key cannot be minted with more than its creator holds.`
    );
  }

  // A trimmed-to-empty list is a key that authenticates and can do nothing — it looks
  // like a working credential and behaves like a revoked one, so refuse instead.
  if (!held.length) {
    throw new ScopeCeilingError(
      `The creator holds none of the default scopes, so there is nothing to mint.`
    );
  }
  return held;
}

/**
 * Workspace membership for the ceiling's bound-key check.
 *
 * Service principals have no membership rows and are not workspace members of anything;
 * a single-user deployment has one operator who administers every workspace, which is
 * why that principal is allowed through rather than looked up.
 */
async function creatorInWorkspace(actor, workspaceId, db) {
  if (actor.type !== "user") return true;
  try {
    const row = await db.workspace_users.findFirst({
      where: { user_id: Number(actor.id), workspace_id: workspaceId },
      select: { id: true },
    });
    return !!row;
  } catch (error) {
    // Fail closed: an unreadable membership table is not evidence of membership.
    throw new AuthorizationUnavailableError(
      `membership lookup failed for workspace ${workspaceId}: ${error.message}`
    );
  }
}

module.exports = {
  applyScopeCeiling,
  KeyMintForbiddenError,
  ScopeCeilingError,
  KEY_MINT_ACTION,
};
