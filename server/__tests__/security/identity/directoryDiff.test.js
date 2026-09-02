/**
 * S4b slice 1 (#133): the pure directory diff.
 *
 * Lark has no delta API (#113), so every sync is a full snapshot and ABSENCE from that
 * snapshot is the only way to learn that someone left. That makes this function the one
 * component that can revoke an entire organisation's access from a single bad input.
 *
 * WHAT THESE TESTS REFUSE TO DO. The acceptance test named in the S4b recon —
 * "interrupt an enumeration and prove zero deactivations" — is NECESSARY BUT NOT
 * SUFFICIENT: a diff that never deactivates anyone passes it. So every interrupted-run
 * assertion here is paired with a completed-run assertion on the SAME fixture proving
 * the departed user IS deactivated. Neither pins the rule alone.
 *
 * That is the lesson #113 paid for: its RF-1 refusal tests only meant something because
 * the 5,000-principal success test ran beside them.
 *
 * No database. This slice computes a plan and writes nothing (R6) — the write path,
 * the checkpoint and the job handler are slices 2 and 3.
 */

const path = require("path");
const fs = require("fs");
const {
  diffDirectory,
  completedEnumeration,
  failedEnumeration,
  DirectoryDiffError,
} = require("../../../utils/identity/directoryDiff");

/** A DirectoryPrincipal as S4a's driver actually returns one. */
const principal = (subject, overrides = {}) => ({
  provider: "lark",
  subject,
  email: `${subject}@corp.example.com`,
  emailVerified: false,
  active: true,
  displayName: subject,
  groupExternalIds: [],
  revision: null,
  ...overrides,
});

/** A DirectoryGroup as S4a returns one — memberExternalIds ALWAYS empty. */
const group = (externalId, overrides = {}) => ({
  externalId,
  name: `dept-${externalId}`,
  memberExternalIds: [],
  parentExternalId: null,
  revision: null,
  ...overrides,
});

/** Current database state, in the shape the diff consumes. */
const state = ({ users = [], groups = [], memberships = [] } = {}) => ({
  users,
  groups,
  memberships,
});

const linkedUser = (subject, overrides = {}) => ({
  id: overrides.id ?? (Number(subject.replace(/\D/g, "")) || 1),
  subject,
  provider: "lark",
  suspended: 0,
  ...overrides,
});

describe("#133 R1/R2: completeness is a property of the value, not a flag", () => {
  test("T1 interrupted: a user absent from an INCOMPLETE enumeration is not deactivated", async () => {
    // The destructive case. u-1 is genuinely gone from what came back, but the
    // enumeration did not finish — so absence carries no information at all.
    const before = state({ users: [linkedUser("u-1"), linkedUser("u-2")] });

    const plan = diffDirectory({
      enumeration: failedEnumeration({
        reason: "rate limited on page 37",
        principals: [principal("u-2")],
      }),
      current: before,
    });

    expect(plan.deactivate).toEqual([]);
  });

  test("T2 completed, SAME fixture: the absent user IS deactivated", async () => {
    // Without this, T1 is satisfied by a diff that deactivates nobody ever. Same
    // state, same present/absent users — only completeness differs.
    const before = state({ users: [linkedUser("u-1"), linkedUser("u-2")] });

    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-2")],
        groups: [],
      }),
      current: before,
    });

    expect(plan.deactivate.map((d) => d.subject)).toEqual(["u-1"]);
  });

  test("a failed enumeration cannot even be constructed as a complete one", async () => {
    // R1 as a TYPE property rather than a branch. `completedEnumeration` is the only
    // way to produce a value the diff will plan deactivations from, so deleting a
    // check does not silently re-enable them — there is no check to delete.
    const failed = failedEnumeration({ reason: "boom", principals: [] });
    expect(failed.status).not.toBe("complete");

    // And the diff refuses to be handed a raw object that merely claims completeness.
    expect(() =>
      diffDirectory({
        enumeration: { status: "complete", principals: [], groups: [] },
        current: state(),
      })
    ).toThrow(DirectoryDiffError);
  });

  test("T3: listGroups failing is enough to block deactivation on its own", async () => {
    // R1's second call. listPrincipals succeeded and looks authoritative; the run is
    // still not complete, and conflating the two turns one Lark 500 into an org-wide
    // deactivation.
    const before = state({ users: [linkedUser("u-1"), linkedUser("u-2")] });

    const plan = diffDirectory({
      enumeration: failedEnumeration({
        reason: "listGroups threw",
        principals: [principal("u-2")],
        groups: null,
      }),
      current: before,
    });

    expect(plan.deactivate).toEqual([]);
    // And it is not silently empty: the caller can tell a blocked plan from a
    // no-op one, which is what lets slice 3 alert instead of reporting success.
    expect(plan.complete).toBe(false);
  });
});

describe("#133 R3: quarantine and deactivation are different outcomes", () => {
  test("T4: a principal with no email is quarantined, and does NOT deactivate its user", async () => {
    // S4a returns `email: null` when Lark has neither address (it refuses to invent
    // one). That record is unusable, not a departure — routing it into deactivation
    // turns a Lark data-entry error into a revocation.
    const before = state({ users: [linkedUser("u-1")] });

    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-1", { email: null })],
        groups: [],
      }),
      current: before,
    });

    expect(plan.quarantine.map((q) => q.subject)).toEqual(["u-1"]);
    expect(plan.deactivate).toEqual([]);
    expect(plan.create).toEqual([]);
  });

  test("a quarantined NEW principal is not created either", async () => {
    // The other direction: unusable records do not become users. "Quarantined without
    // widening membership" is the seam's wording.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-new", { email: null })],
        groups: [],
      }),
      current: state(),
    });

    expect(plan.create).toEqual([]);
    expect(plan.quarantine.map((q) => q.subject)).toEqual(["u-new"]);
  });
});

describe("#133 R4: the scale guard needs a floor as well as a ratio", () => {
  test("T6: a completed snapshot losing most of a large org REFUSES", async () => {
    // Far more likely a misconfigured Lark app — wrong tenant, narrowed scope — than
    // attrition. And it is the one failure the next sync cannot undo: suspended users
    // are rejected with 401 immediately (validatedRequest.js:114), so they are logged
    // out mid-work before anyone notices the sync was wrong.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-0"), principal("u-1")],
        groups: [],
      }),
      current: state({ users }),
    });

    expect(plan.refused).toBe(true);
    expect(plan.deactivate).toEqual([]);
    expect(plan.refusedReason).toMatch(/scale/i);
  });

  test("a SMALL org OVER the ratio is still allowed — the floor is why", async () => {
    // The floor's whole reason for existing, and it must be measured ABOVE the ratio
    // or it measures nothing. Six people, four leave: 66%, comfortably past any
    // sensible percentage — and four departures is not evidence of a misconfigured
    // directory app at that size.
    //
    // An earlier version of this test used two departures (33%), which is BELOW the
    // threshold — so a ratio-only guard passed it too, and the mutant that deletes
    // the floor survived. The test has to sit in the band where floor and ratio
    // disagree, or it is not testing the floor at all.
    const users = Array.from({ length: 6 }, (_, i) => linkedUser(`s-${i}`));
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("s-0"), principal("s-1")],
        groups: [],
      }),
      current: state({ users }),
    });

    expect(plan.refused).toBe(false);
    expect(plan.deactivate.map((d) => d.subject).sort()).toEqual([
      "s-2", "s-3", "s-4", "s-5",
    ]);
  });

  test("a large org losing a NORMAL number is allowed", async () => {
    // The control that keeps T6 from being satisfied by "refuse whenever anyone
    // leaves". Two departures out of a hundred is ordinary.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const present = users.slice(0, 98).map((u) => principal(u.subject));
    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals: present, groups: [] }),
      current: state({ users }),
    });

    expect(plan.refused).toBe(false);
    expect(plan.deactivate).toHaveLength(2);
  });
});

describe("#133 RF-5: membership comes from principals, never from groups", () => {
  test("membership is built from department_ids on the USER record", async () => {
    // THE mutant this exists for: building membership from `listGroups` instead.
    // S4a returns `memberExternalIds: []` on every group, always and deliberately —
    // Lark carries membership on the user record. So a diff that reads membership
    // from groups produces an EMPTY membership set: silently plausible, and it
    // removes everyone from every group.
    //
    // Asserted on CONTENT, not on "a plan was produced", because the empty result is
    // exactly what the defect looks like.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [
          principal("u-1", { groupExternalIds: ["d-100"] }),
          principal("u-2", { groupExternalIds: ["d-100", "d-200"] }),
        ],
        groups: [group("d-100"), group("d-200")],
      }),
      current: state({ users: [linkedUser("u-1"), linkedUser("u-2")] }),
    });

    const pairs = plan.addMembership
      .map((m) => `${m.subject}:${m.groupExternalId}`)
      .sort();
    expect(pairs).toEqual(["u-1:d-100", "u-2:d-100", "u-2:d-200"]);
  });

  test("a group nobody references is still created, and has no members", async () => {
    // The first dangling direction. An empty department is legitimate — it exists in
    // Lark and will be granted roles in S4c — so it must not be dropped, and it must
    // not acquire members from nowhere.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-1", { groupExternalIds: [] })],
        groups: [group("d-empty")],
      }),
      current: state({ users: [linkedUser("u-1")] }),
    });

    expect(plan.createGroups.map((g) => g.externalId)).toContain("d-empty");
    expect(plan.addMembership).toEqual([]);
  });

  test("a department_id naming a group absent from listGroups is reported, not invented", async () => {
    // The second dangling direction, and the dangerous one. The two enumerations are
    // separate calls with no ordering guarantee, so this happens in normal operation.
    // Creating the group from the reference alone would mean the USER record decides
    // what departments exist — the directory's own group list would stop being
    // authoritative.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-1", { groupExternalIds: ["d-ghost"] })],
        groups: [],
      }),
      current: state({ users: [linkedUser("u-1")] }),
    });

    expect(plan.createGroups).toEqual([]);
    expect(plan.addMembership).toEqual([]);
    expect(plan.danglingGroupRefs).toEqual([
      { subject: "u-1", groupExternalId: "d-ghost" },
    ]);
  });
});

describe("#133 R5: the plan is derived from current state, so replay is empty", () => {
  test("T5: applying the same snapshot to already-applied state produces an empty plan", async () => {
    // Idempotency by construction rather than by bookkeeping. A run-id check would
    // only protect against exact replays; deriving from state also handles two
    // overlapping runs arriving at the same answer.
    const enumeration = completedEnumeration({
      principals: [principal("u-1", { groupExternalIds: ["d-1"] })],
      groups: [group("d-1")],
    });
    const applied = state({
      users: [linkedUser("u-1")],
      groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
      memberships: [{ subject: "u-1", groupExternalId: "d-1" }],
    });

    const plan = diffDirectory({ enumeration, current: applied });

    expect(plan.create).toEqual([]);
    expect(plan.createGroups).toEqual([]);
    expect(plan.addMembership).toEqual([]);
    expect(plan.removeMembership).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  test("a membership the directory no longer claims is removed", async () => {
    // The control for the test above: "empty plan" must mean "nothing to do", not
    // "this function returns empty plans".
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [principal("u-1", { groupExternalIds: [] })],
        groups: [group("d-1")],
      }),
      current: state({
        users: [linkedUser("u-1")],
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships: [{ subject: "u-1", groupExternalId: "d-1" }],
      }),
    });

    expect(plan.removeMembership).toEqual([
      { subject: "u-1", groupExternalId: "d-1" },
    ]);
  });
});

describe("#133 R6: this slice computes, and cannot write", () => {
  test("T7: the module imports no database client and no policy repository", async () => {
    // Not decoration. Membership writes must go through addGroupMember /
    // removeGroupMember (#113 RF-5) because those carry the policy-version bump and
    // the outbox publish in one transaction. A diff that could write would be the
    // obvious place to "just do it here", and the version bump would be lost.
    //
    // Comments are stripped first: a prohibition written in a comment must not
    // satisfy its own grep.
    const source = fs.readFileSync(
      path.join(__dirname, "../../../utils/identity/directoryDiff.js"),
      "utf8"
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toMatch(/require\(["'].*prisma/);
    expect(code).not.toMatch(/policyRepository/);
    expect(code).not.toMatch(/group_members/);
  });
});
