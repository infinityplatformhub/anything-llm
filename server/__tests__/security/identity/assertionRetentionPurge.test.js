// S2 (#43) — identity_assertion_ids is swept by the SAME T-6 retention job.
//
// PMO ruling Q-3, inherited from S1: register with the existing purge, never a
// new sweeper and never a deleteMany from an endpoint. This table grows by one
// row per SAML login attempt, and an unauthenticated attacker sets that rate —
// so the sweep is not housekeeping, it is what stops a cheap disk fill.

const { purge } = require("../../../utils/retention/purge");
const { handlers } = require("../../../utils/jobs/handlers");

/**
 * A fake db recording what the purge asked for. The audit half is stubbed to
 * "nothing to delete" so these tests speak only about the identity tables.
 */
function fakeDb({ assertionsDeleted = 0 } = {}) {
  const calls = { assertionDeleteWhere: null };
  return {
    calls,
    system_settings: { findFirst: async () => ({ value: "30" }) },
    event_logs: { findMany: async () => [] },
    identity_login_state: { deleteMany: async () => ({ count: 0 }) },
    identity_assertion_ids: {
      deleteMany: async ({ where }) => {
        calls.assertionDeleteWhere = where;
        return { count: assertionsDeleted };
      },
    },
  };
}

describe("retention purge covers identity_assertion_ids", () => {
  test("the purge sweeps expired assertion IDs and reports the count", async () => {
    const db = fakeDb({ assertionsDeleted: 3 });
    const result = await purge({ db });

    expect(db.calls.assertionDeleteWhere).not.toBeNull();
    expect(result.assertionIdsPurged).toBe(3);
  });

  test("it deletes by EXPIRY only", async () => {
    const db = fakeDb();
    await purge({ db });

    // Any other criterion — age, a batch cap, "keep the last N" — either keeps
    // rows that protect nothing or drops rows whose assertions are still
    // replayable, which reopens the attack the table exists to close.
    const where = db.calls.assertionDeleteWhere;
    expect(where).toHaveProperty("expiresAt");
    expect(Object.keys(where)).toEqual(["expiresAt"]);
  });

  test("assertion IDs are swept even when the audit window is unusable", async () => {
    // The audit purge fails closed on a bad window and deletes nothing. That
    // must not stop this sweep: they are unrelated clocks, and an operator who
    // never configured audit retention would otherwise grow this table forever.
    const db = fakeDb({ assertionsDeleted: 5 });
    db.system_settings.findFirst = async () => ({ value: "not-a-number" });

    const result = await purge({ db });
    expect(result.skipped).toBe(true);
    expect(result.purged).toBe(0);
    expect(result.assertionIdsPurged).toBe(5);
  });

  test("the scheduled job reports the count", async () => {
    const db = fakeDb({ assertionsDeleted: 2 });
    const result = await handlers["retention.purge@1"]({ traceId: "t-1", db });
    expect(result.assertionIdsPurged).toBe(2);
  });
});
