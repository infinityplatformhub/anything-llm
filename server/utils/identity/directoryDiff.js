// S4b slice 1 (#133): the pure directory diff.
//
// Snapshot + current state -> a PLAN. This module computes; it does not write, and it
// cannot: it imports no database client and no repository (R6, pinned by a source
// test). Membership writes belong to slice 2 and must go through
// `addGroupMember`/`removeGroupMember`, because those carry the policy-version bump and
// the outbox publish in one transaction (#113 RF-5). A diff that could write would be
// the obvious place to "just do it here", and the bump would be lost.
//
// WHAT SLICE 2 (#134) ADDED, and why it is here rather than beside the driver.
// `enumerateDirectory` DOES call a driver — it is the only producer of a completed
// enumeration in production. That does not weaken R6: it takes the driver as an
// ARGUMENT and imports none, so this module still reaches no database, no repository
// and no concrete provider (the source test below pins all three).
//
// It lives in this file for a structural reason. The `COMPLETE` brand is a
// module-private symbol, so a producer in any other file would need that symbol
// exported — and an exported symbol is a constructor again, just with more steps.
// Keeping the brand and its only producer together means completeness cannot be
// asserted anywhere it is not audited. `completedEnumeration` is reachable only
// through `__testHelpers__` for the same reason.
//
// THE RULE EVERYTHING BELOW SERVES. Lark has no delta API (#113), so every sync is a
// full snapshot and ABSENCE from that snapshot is the only way to learn that someone
// left. That makes this the one component that can revoke an entire organisation's
// access from a single bad input.

class DirectoryDiffError extends Error {
  constructor(message) {
    super(message);
    this.name = "DirectoryDiffError";
  }
}

// A private marker. `status: "complete"` is not enough on its own — a caller could
// hand-build that object, and then completeness would be a string anyone can type
// rather than a fact the enumeration produced. Holding the brand means the value came
// from `completedEnumeration`, which is the only thing that should be able to assert
// a finished enumeration.
const COMPLETE = Symbol("directory.enumeration.complete");

/**
 * Both enumerations finished. This is the ONLY value the diff will plan deactivations
 * from.
 *
 * TL-1 (#133 A1): completeness is a property of the TYPE, not a boolean field. A
 * `{ complete: boolean }` flag is a branch, and a branch can be deleted — a mutant
 * that removes `if (!input.complete)` leaves nothing to fail against. Here there is no
 * check to delete: a failed enumeration simply is not a value that can produce
 * deactivations.
 */
function completedEnumeration({ principals = [], groups = [] } = {}) {
  return { status: "complete", principals, groups, [COMPLETE]: true };
}

/**
 * An enumeration that did not finish, for any reason. Carries whatever was collected —
 * a caller may still want to log it — but that data can never drive a departure.
 *
 * `groups: null` is the shape when `listGroups` threw after `listPrincipals`
 * succeeded. The principals look authoritative and are not: the run is incomplete, and
 * conflating the two turns one Lark 500 into an org-wide deactivation.
 */
function failedEnumeration({ reason, principals = [], groups = [] } = {}) {
  return { status: "failed", reason, principals, groups };
}

const isComplete = (enumeration) => enumeration?.[COMPLETE] === true;

// The scale guard (TL-1 #133 A2). BOTH conditions, never either.
//
// A ratio alone is wrong on small organisations: six people with two genuine
// departures is 33%, which trips any sensible percentage. A guard that fires on an
// ordinary Tuesday at a small company gets disabled, and a disabled guard protects
// nothing — so the floor is what keeps the ratio credible.
//
// Ruling: FLOOR = 10. Below eleven departures, no proportion is evidence of a
// misconfiguration; a small team can lose a third of itself for entirely ordinary
// reasons, and blocking that is a false positive on the most common case.
//
// Ruling: THRESHOLD = 0.5. Half an organisation vanishing between two syncs is far
// more likely a misconfigured Lark app — wrong tenant, narrowed scope — than
// attrition. Set lower, reorganisations and seasonal contractor churn trip it; set
// higher, a scope narrowed to one department slips through.
//
// The cost of being wrong is asymmetric, which is why this refuses rather than warns:
// `validatedRequest.js:114` rejects a suspended user with 401 immediately, so a wrong
// deactivation logs people out mid-work before anyone notices the sync was bad. It is
// reversible in the database and not reversible in experience.
const DEACTIVATION_FLOOR = 10;
const DEACTIVATION_RATIO = 0.5;

// The SECOND scale guard (TL-1 F1). Mine was the defect it exists for: I guarded the
// deactivation path and left the membership path open, in exactly the misconfiguration
// the comment above names. Measured on the pre-fix code, 100 users all present with
// `department_ids` empty:
//
//   deactivate: 0 · refused: false · removeMembership: 100
//
// Nobody looks departed, so the deactivation guard never fires — and since #96 group
// membership carries grants, so that plan silently revokes group-derived access for
// the whole organisation. A narrowed Lark scope produces exactly this shape.
//
// Separate constants, not shared with the deactivation guard: memberships are
// many-per-user, so the two quantities are different in kind and a floor tuned for
// headcount means nothing here.
//
// Ruling: MEMBERSHIP_FLOOR = 25. Below that, wholesale membership loss is a small
// reorganisation rather than evidence of a broken directory app.
//
// Ruling: MEMBERSHIP_RATIO = 0.5. Same reasoning as the deactivation threshold: half
// the organisation's memberships ending between two syncs is more likely a scope
// change than a reorganisation everyone forgot to mention.
const MEMBERSHIP_FLOOR = 25;
const MEMBERSHIP_RATIO = 0.5;

/**
 * The ONLY producer of a completed enumeration in production (#134 R2).
 *
 * It lives in this module rather than beside the sync driver for a structural reason:
 * `COMPLETE` is module-private, so a producer in any other file would need the symbol
 * exported — and an exported symbol is a constructor again, just with more steps.
 * Keeping both here means the brand cannot be applied anywhere it is not audited.
 *
 * N-2 (TL-1): the shape is ASSERTED before branding, not assumed from the driver's
 * behaviour. S4a refuses to return a prefix (`LarkIdentityProvider._enumerate` throws
 * on a cursor), so today a partial result is impossible — but that is a property of
 * ONE implementation, and the brand is what every downstream guard trusts. A future
 * driver that returns a partial result without throwing would otherwise have it
 * branded complete, and the type discipline collapses at its source.
 *
 * Both calls must succeed. If `listGroups` throws after `listPrincipals` returned,
 * this throws too and NO branded value exists — the principals look authoritative and
 * are not, and conflating the two turns one Lark 500 into an org-wide deactivation.
 *
 * @param {{listPrincipals: Function, listGroups: Function}} driver
 * @returns {Promise<Object>} a branded completed enumeration
 */
async function enumerateDirectory(driver, input = {}) {
  if (!driver || typeof driver.listPrincipals !== "function" || typeof driver.listGroups !== "function") {
    throw new DirectoryDiffError(
      "enumerateDirectory requires a driver with listPrincipals and listGroups"
    );
  }

  const principalPage = await driver.listPrincipals(input);
  assertCompletePage(principalPage, "principals", "listPrincipals");
  const groupPage = await driver.listGroups(input);
  assertCompletePage(groupPage, "groups", "listGroups");

  return completedEnumeration({
    principals: principalPage.principals,
    groups: groupPage.groups,
  });
}

/**
 * A page is only usable as part of a completed enumeration when it says, in every
 * field, that there is nothing after it. `hasMore: true` with a full-looking array is
 * exactly the shape that reads as a complete snapshot while being a prefix.
 */
function assertCompletePage(page, collection, method) {
  if (!page || typeof page !== "object") {
    throw new DirectoryDiffError(`${method} must return a page object`);
  }
  if (!Array.isArray(page[collection])) {
    throw new DirectoryDiffError(`${method} must return an array of ${collection}`);
  }
  if (page.hasMore !== false || page.nextCursor != null) {
    throw new DirectoryDiffError(
      `${method} returned a PARTIAL enumeration (hasMore=${page.hasMore}, ` +
        `nextCursor=${String(page.nextCursor)}). Absence from a partial snapshot is ` +
        `not a departure, so it cannot be branded complete.`
    );
  }
}

/**
 * @param {{enumeration: Object, current: {users: Array, groups: Array, memberships: Array}}} input
 * @returns {Object} the plan
 */
function diffDirectory({ enumeration, current }) {
  if (!enumeration || typeof enumeration !== "object") {
    throw new DirectoryDiffError("diffDirectory requires an enumeration result");
  }
  // A raw object claiming `status: "complete"` is refused. Completeness is something
  // the enumeration reports, not something a caller can assert on its behalf.
  if (enumeration.status === "complete" && !isComplete(enumeration)) {
    throw new DirectoryDiffError(
      "an enumeration claiming completeness must come from completedEnumeration() — " +
        "completeness is a fact the enumeration records, not a field a caller sets"
    );
  }

  const users = current?.users ?? [];
  const currentGroups = current?.groups ?? [];
  const currentMemberships = current?.memberships ?? [];
  const complete = isComplete(enumeration);
  const principals = enumeration.principals ?? [];
  const groups = enumeration.groups ?? [];

  // ---- quarantine ---------------------------------------------------------
  // Unusable, NOT departed. S4a returns `email: null` when Lark has neither address
  // (it refuses to invent one), and such a record cannot be matched or created.
  //
  // The seam's wording is "quarantined without widening membership". Critically, a
  // quarantined record must not fall through to deactivation either: routing a
  // degraded record down that path turns a Lark data-entry error into a revocation.
  const quarantine = [];
  const usable = [];
  for (const principal of principals) {
    if (!principal.email) {
      quarantine.push(principal);
      continue;
    }
    usable.push(principal);
  }
  const quarantined = new Set(quarantine.map((p) => p.subject));

  // ---- users --------------------------------------------------------------
  const bySubject = new Map(users.map((u) => [u.subject, u]));
  const present = new Set(usable.map((p) => p.subject));

  const create = usable.filter((p) => !bySubject.has(p.subject));

  // Absence means departure ONLY from a completed enumeration. Note this reads
  // `complete`, but the value it reads cannot be forged (see COMPLETE above), so the
  // guard is not the last line of defence — it is the expression of a property the
  // input already carries.
  //
  // A quarantined subject is excluded explicitly: it IS present in the directory, just
  // unusable, so it is not absent and must not be treated as such.
  const deactivate = complete
    ? users.filter(
        (u) =>
          !present.has(u.subject) && !quarantined.has(u.subject) && !u.suspended
      )
    : [];

  // ---- groups -------------------------------------------------------------
  const currentGroupIds = new Set(currentGroups.map((g) => g.externalId));
  const snapshotGroupIds = new Set(groups.map((g) => g.externalId));
  const createGroups = groups.filter((g) => !currentGroupIds.has(g.externalId));

  // ---- membership ---------------------------------------------------------
  // RF-5: membership is built from the PRINCIPAL's `groupExternalIds`, never from a
  // group's `memberExternalIds`. S4a returns the latter as `[]` on every group, always
  // and deliberately — Lark carries membership on the user record. A diff that read
  // membership from groups would produce an empty membership set: silently plausible,
  // and it removes everyone from every group.
  const desired = new Set();
  const danglingGroupRefs = [];
  for (const principal of usable) {
    for (const groupExternalId of principal.groupExternalIds ?? []) {
      // A department_id naming a group absent from `listGroups`. The two enumerations
      // are separate calls with no ordering guarantee, so this happens in normal
      // operation. Reported rather than created: inventing the group from the
      // reference would mean the USER record decides what departments exist, and the
      // directory's own group list would stop being authoritative.
      if (!snapshotGroupIds.has(groupExternalId) && !currentGroupIds.has(groupExternalId)) {
        danglingGroupRefs.push({ subject: principal.subject, groupExternalId });
        continue;
      }
      desired.add(`${principal.subject} ${groupExternalId}`);
    }
  }

  const held = new Set(
    currentMemberships.map((m) => `${m.subject} ${m.groupExternalId}`)
  );
  const split = (key) => {
    const [subject, groupExternalId] = key.split(" ");
    return { subject, groupExternalId };
  };

  const addMembership = [...desired].filter((k) => !held.has(k)).map(split);
  // Removal is only meaningful from a completed enumeration, for the same reason
  // deactivation is: a partial snapshot's silence about a membership is not a claim
  // that it ended.
  //
  // A QUARANTINED subject is excluded here exactly as it is from `deactivate` (TL-1
  // F2). Its record is unusable, which is not a statement about its membership — the
  // `groupExternalIds` on an invalid record cannot be trusted in either direction. A
  // temporarily degraded directory record must not become a revocation; narrowing is
  // damage too, not just deactivation.
  const removeMembership = complete
    ? [...held]
        .filter((k) => !desired.has(k))
        .map(split)
        .filter((m) => !quarantined.has(m.subject))
    : [];

  // ---- scale guards -------------------------------------------------------
  // TWO guards, on two different quantities. The deactivation guard alone was the F1
  // defect: a narrowed Lark scope returns everyone (so nothing is deactivated) with
  // no departments (so every membership ends), and the org loses its group-derived
  // access without a single deactivation to trip the first guard.
  const refusedDeactivations =
    deactivate.length > DEACTIVATION_FLOOR &&
    users.length > 0 &&
    deactivate.length / users.length > DEACTIVATION_RATIO;

  const refusedMemberships =
    removeMembership.length > MEMBERSHIP_FLOOR &&
    currentMemberships.length > 0 &&
    removeMembership.length / currentMemberships.length > MEMBERSHIP_RATIO;

  const refused = refusedDeactivations || refusedMemberships;

  return {
    // Reported so a caller can tell a BLOCKED plan from a no-op one. Slice 3 needs
    // that difference to alert instead of reporting a clean run.
    complete,
    refused,
    refusedReason: refusedDeactivations
      ? `scale guard: ${deactivate.length} of ${users.length} users would be ` +
        `deactivated (floor ${DEACTIVATION_FLOOR}, threshold ` +
        `${DEACTIVATION_RATIO * 100}%) — more likely a misconfigured directory app ` +
        `than attrition`
      : refusedMemberships
        ? `scale guard: ${removeMembership.length} of ${currentMemberships.length} ` +
          `memberships would be removed (floor ${MEMBERSHIP_FLOOR}, threshold ` +
          `${MEMBERSHIP_RATIO * 100}%) — a directory app whose scope was narrowed ` +
          `returns everyone with no departments, which ends every membership while ` +
          `deactivating nobody`
        : null,
    create,
    // A refused plan carries NEITHER destructive list rather than carrying them with a
    // flag set. A caller that forgets to check `refused` then does nothing, instead of
    // doing the destructive thing — and BOTH are cleared whichever guard fired, since
    // a run this wrong about one is not to be trusted about the other.
    deactivate: refused ? [] : deactivate,
    quarantine,
    createGroups,
    addMembership,
    removeMembership: refused ? [] : removeMembership,
    danglingGroupRefs,
  };
}

module.exports = {
  diffDirectory,
  enumerateDirectory,
  // NOT `completedEnumeration`. #134 R2: `enumerateDirectory` is the only producer of
  // a branded value in production. The brand certifies PROVENANCE, not truth — it
  // records that a value came from the constructor, not that an enumeration finished
  // — so a constructor reachable from production code is a way to stamp "complete"
  // onto data from a run that failed, and every guard below then reasons from a lie
  // it cannot detect. The constructor still exists (`__testHelpers__`), because slice
  // 1's tests build enumerations without a driver; what changed is that reaching it
  // now requires naming a test helper, which is visible in review.
  __testHelpers__: { completedEnumeration },
  failedEnumeration,
  DirectoryDiffError,
  DEACTIVATION_FLOOR,
  DEACTIVATION_RATIO,
  MEMBERSHIP_FLOOR,
  MEMBERSHIP_RATIO,
};
