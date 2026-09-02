// S4b slice 1 (#133): the pure directory diff.
//
// Snapshot + current state -> a PLAN. This module computes; it does not write, and it
// cannot: it imports no database client and no repository (R6, pinned by a source
// test). Membership writes belong to slice 2 and must go through
// `addGroupMember`/`removeGroupMember`, because those carry the policy-version bump and
// the outbox publish in one transaction (#113 RF-5). A diff that could write would be
// the obvious place to "just do it here", and the bump would be lost.
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

  // ---- scale guard --------------------------------------------------------
  const refused =
    deactivate.length > DEACTIVATION_FLOOR &&
    users.length > 0 &&
    deactivate.length / users.length > DEACTIVATION_RATIO;

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
  const removeMembership = complete
    ? [...held].filter((k) => !desired.has(k)).map(split)
    : [];

  return {
    // Reported so a caller can tell a BLOCKED plan from a no-op one. Slice 3 needs
    // that difference to alert instead of reporting a clean run.
    complete,
    refused,
    refusedReason: refused
      ? `scale guard: ${deactivate.length} of ${users.length} users would be ` +
        `deactivated (floor ${DEACTIVATION_FLOOR}, threshold ` +
        `${DEACTIVATION_RATIO * 100}%) — more likely a misconfigured directory app ` +
        `than attrition`
      : null,
    create,
    // A refused plan carries NO deactivations rather than carrying them with a flag
    // set. A caller that forgets to check `refused` then does nothing, instead of
    // doing the destructive thing.
    deactivate: refused ? [] : deactivate,
    quarantine,
    createGroups,
    addMembership,
    removeMembership,
    danglingGroupRefs,
  };
}

module.exports = {
  diffDirectory,
  completedEnumeration,
  failedEnumeration,
  DirectoryDiffError,
  DEACTIVATION_FLOOR,
  DEACTIVATION_RATIO,
};
