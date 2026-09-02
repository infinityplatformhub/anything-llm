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
  __testHelpers__: { completedEnumeration },
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
    const before = state({
      users: [linkedUser("u-1"), linkedUser("u-2")],
      groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
      memberships: [
        { subject: "u-1", groupExternalId: "d-1" },
        { subject: "u-2", groupExternalId: "d-1" },
      ],
    });

    const plan = diffDirectory({
      enumeration: failedEnumeration({
        reason: "rate limited on page 37",
        principals: [principal("u-2")],
      }),
      current: before,
    });

    expect(plan.deactivate).toEqual([]);
    // QA-1 NIT-2: membership REMOVAL is bound to completeness too, and it needed its
    // own witness — a mutant unbinding it survived, because the incomplete fixtures
    // carried no memberships to remove. An incomplete run says nothing about
    // membership either: since #96 those rows carry grants, so stripping them on a
    // rate-limited page is the same org-wide revocation by a different route.
    expect(plan.removeMembership).toEqual([]);
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
    const before = state({
      users: [linkedUser("u-1"), linkedUser("u-2")],
      groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
      memberships: [
        { subject: "u-1", groupExternalId: "d-1" },
        { subject: "u-2", groupExternalId: "d-1" },
      ],
    });

    const plan = diffDirectory({
      enumeration: failedEnumeration({
        reason: "listGroups threw",
        principals: [principal("u-2")],
        groups: null,
      }),
      current: before,
    });

    expect(plan.deactivate).toEqual([]);
    // NIT-2 again, and this is the sharper case: `listGroups` is exactly the call
    // whose failure makes every department look empty. Removing memberships here
    // would revoke group-derived access for everyone the run happened to reach.
    expect(plan.removeMembership).toEqual([]);
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

  test("OVER the deactivation floor but UNDER its ratio is allowed — the ratio arm", async () => {
    // The deactivation ratio had no witness of its own: every fixture clearing
    // DEACTIVATION_FLOOR also cleared DEACTIVATION_RATIO, so the floor alone explained
    // every result and replacing the ratio with `&& true` survived.
    //
    // 11 of 100 leave: past the floor (10) and far under the ratio (50%). Only the
    // ratio can allow this, which is the band where the two arms disagree — the same
    // discipline the membership ratio test already follows.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const present = users.slice(11).map((u) => principal(u.subject));

    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals: present, groups: [] }),
      current: state({ users }),
    });

    expect(plan.refused).toBe(false);
    expect(plan.deactivate).toHaveLength(11);
  });

  test("when the MEMBERSHIP guard refuses, the deactivation list is cleared too", async () => {
    // `refused` clears BOTH destructive lists whichever guard fired, and that had no
    // witness either: every membership-refusal fixture had an empty deactivation list
    // to begin with, so `refusedDeactivations ? [] : deactivate` would have passed
    // them all while still shipping deactivations on a membership-refused run.
    //
    // Here 12 people genuinely leave (under the deactivation ratio, so that guard
    // stays silent) while the remaining 88 lose their department — which trips the
    // membership guard. A run this wrong about memberships is not to be trusted about
    // departures either, so both lists must come back empty.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const memberships = users.map((u) => ({
      subject: u.subject,
      groupExternalId: "d-1",
    }));
    // 12 absent entirely; the other 88 present but with no departments.
    const principals = users
      .slice(12)
      .map((u) => principal(u.subject, { groupExternalIds: [] }));

    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals, groups: [group("d-1")] }),
      current: state({
        users,
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships,
      }),
    });

    expect(plan.refused).toBe(true);
    expect(plan.refusedReason).toMatch(/membership/i);
    expect(plan.removeMembership).toEqual([]);
    // The assertion this test exists for: cleared by the MEMBERSHIP guard, not by its
    // own.
    expect(plan.deactivate).toEqual([]);
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

describe("#133 RF-6: the scale guard covers membership, not just deactivation", () => {
  test("a snapshot with everyone PRESENT but no departments refuses", async () => {
    // TL-1 F1, and it is my defect: I guarded the deactivation path and left the
    // membership path open, in exactly the misconfiguration the guard's own comment
    // names. Measured on the pre-fix code:
    //
    //   deactivate: 0 · refused: false · removeMembership: 100
    //
    // A Lark app whose scope was narrowed returns every user (so nobody looks
    // departed) with `department_ids` empty (so every membership looks ended). Since
    // #96 group membership carries grants, so that plan silently revokes
    // group-derived access for the whole organisation — and the deactivation guard
    // never fires, because nothing was deactivated.
    //
    // The fixture is deliberately one where NOBODY LEFT. A guard counting only
    // deactivations is green here, which is what makes this test measure the new one.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const memberships = users.map((u) => ({
      subject: u.subject,
      groupExternalId: "d-1",
    }));

    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: users.map((u) => principal(u.subject, { groupExternalIds: [] })),
        groups: [group("d-1")],
      }),
      current: state({
        users,
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships,
      }),
    });

    expect(plan.refused).toBe(true);
    expect(plan.removeMembership).toEqual([]);
    // And the deactivation list stays empty too — a refused plan carries neither
    // destructive list, so a caller that forgets to check `refused` does nothing.
    expect(plan.deactivate).toEqual([]);
    expect(plan.refusedReason).toMatch(/membership/i);
  });

  test("a NORMAL number of membership changes is still allowed", async () => {
    // The control. Without it, "refuse whenever memberships are removed" passes the
    // test above and blocks every ordinary reorganisation — a guard that fires on
    // normal operation gets disabled, and a disabled guard protects nothing.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const memberships = users.map((u) => ({
      subject: u.subject,
      groupExternalId: "d-1",
    }));
    // Two people move out of the department; everyone else stays.
    const principals = users.map((u, i) =>
      principal(u.subject, { groupExternalIds: i < 2 ? [] : ["d-1"] })
    );

    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals, groups: [group("d-1")] }),
      current: state({
        users,
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships,
      }),
    });

    expect(plan.refused).toBe(false);
    expect(plan.removeMembership).toHaveLength(2);
  });

  test("NIT-1: OVER the floor but UNDER the ratio is allowed — the ratio arm", async () => {
    // QA-1: the ratio arm had no witness. A mutant replacing it with `&& true`
    // survives if every fixture that clears the floor also clears the ratio — the
    // floor alone would then explain every result, and the ratio would be decoration.
    //
    // So this sits in the band where the two arms DISAGREE: 30 of 100 memberships end
    // — comfortably OVER MEMBERSHIP_FLOOR (25) and well UNDER MEMBERSHIP_RATIO (50%).
    // The floor has already been cleared, so only the ratio can allow it.
    //
    // Same discipline as the deactivation floor test, and for the same reason: a
    // fixture where both arms agree measures neither.
    const users = Array.from({ length: 100 }, (_, i) => linkedUser(`u-${i}`));
    const memberships = users.map((u) => ({
      subject: u.subject,
      groupExternalId: "d-1",
    }));
    // 70 keep the department, 30 drop it.
    const principals = users.map((u, i) =>
      principal(u.subject, { groupExternalIds: i < 30 ? [] : ["d-1"] })
    );

    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals, groups: [group("d-1")] }),
      current: state({
        users,
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships,
      }),
    });

    expect(plan.refused).toBe(false);
    expect(plan.removeMembership).toHaveLength(30);
  });

  test("a SMALL org losing every membership is allowed — the membership floor", async () => {
    // The floor for this guard is a different quantity from the deactivation floor
    // (memberships are many-per-user), so it is a separate constant and needs its own
    // test in the band where floor and ratio disagree: 100% of memberships gone, but
    // only four of them.
    const users = Array.from({ length: 4 }, (_, i) => linkedUser(`s-${i}`));
    const memberships = users.map((u) => ({
      subject: u.subject,
      groupExternalId: "d-1",
    }));

    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: users.map((u) => principal(u.subject, { groupExternalIds: [] })),
        groups: [group("d-1")],
      }),
      current: state({
        users,
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships,
      }),
    });

    expect(plan.refused).toBe(false);
    expect(plan.removeMembership).toHaveLength(4);
  });
});

describe("#133 RF-7: a quarantined record never causes a revocation", () => {
  test("a quarantined subject's memberships are left alone", async () => {
    // TL-1 F2. The existing quarantine test used a principal with no memberships, so
    // it was green whether or not this held — the same "green for an unrelated
    // reason" shape that has now bitten twice in this file.
    //
    // The ruling: a quarantined record is UNUSABLE, not a statement about membership.
    // Its `groupExternalIds` cannot be trusted either way, so it must be excluded
    // from `removeMembership` exactly as it is excluded from `deactivate`. A
    // temporarily degraded directory record must not become a revocation — the
    // narrowing direction counts as damage too.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [
          principal("u-1", { email: null, groupExternalIds: [] }),
          principal("u-2", { groupExternalIds: ["d-1"] }),
        ],
        groups: [group("d-1")],
      }),
      current: state({
        users: [linkedUser("u-1"), linkedUser("u-2")],
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships: [
          { subject: "u-1", groupExternalId: "d-1" },
          { subject: "u-2", groupExternalId: "d-1" },
        ],
      }),
    });

    expect(plan.quarantine.map((q) => q.subject)).toEqual(["u-1"]);
    expect(plan.removeMembership).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  test("a NON-quarantined user in the same run still loses the membership it dropped", async () => {
    // The control that keeps the test above from being satisfied by "never remove any
    // membership". u-2's record is fine and no longer claims the department.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [
          principal("u-1", { email: null }),
          principal("u-2", { groupExternalIds: [] }),
        ],
        groups: [group("d-1")],
      }),
      current: state({
        users: [linkedUser("u-1"), linkedUser("u-2")],
        groups: [{ externalId: "d-1", name: "dept-d-1", id: 10 }],
        memberships: [
          { subject: "u-1", groupExternalId: "d-1" },
          { subject: "u-2", groupExternalId: "d-1" },
        ],
      }),
    });

    expect(plan.removeMembership).toEqual([
      { subject: "u-2", groupExternalId: "d-1" },
    ]);
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

    // #134 (TL-1 condition ข): also no CONCRETE DRIVER import. Slice 2 added
    // `enumerateDirectory`, which calls `listPrincipals`/`listGroups` — so "this file
    // does not write" now needs a second half to stay enforced. The driver must
    // arrive as an ARGUMENT: a module that could construct its own provider could
    // reach the network, its credentials, and eventually its store, and none of the
    // three greps above would notice.
    expect(code).not.toMatch(/require\(["'].*identityProviders/);
    expect(code).not.toMatch(/IdentityProvider/);
    expect(code).not.toMatch(/require\(["'].*(axios|node-fetch|https?)["']\)/);

    // The require list itself, so a future import of anything at all is a decision
    // someone has to make deliberately rather than a line nobody notices.
    const requires = [...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    expect(requires).toEqual([]);
  });
});
