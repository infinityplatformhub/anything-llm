// S1 (#36) T8 — identity_login_state is swept by the T-6 retention job.
//
// PMO ruling Q-3: register with the existing purge, never a new sweeper and
// never a deleteMany from an endpoint. Without a sweep the table grows on every
// login attempt — including unauthenticated ones — which is a cheap disk fill.

const { purge } = require("../../../utils/retention/purge");
const { handlers } = require("../../../utils/jobs/handlers");

/**
 * A fake db that records what the purge asked for. The audit half is stubbed to
 * "nothing to delete" so these tests speak only about the identity table.
 */
function fakeDb({ loginStateDeleted = 0 } = {}) {
  const calls = { loginStateDeleteWhere: null };
  return {
    calls,
    system_settings: { findFirst: async () => ({ value: "30" }) },
    event_logs: { findMany: async () => [] },
    identity_login_state: {
      deleteMany: async ({ where }) => {
        calls.loginStateDeleteWhere = where;
        return { count: loginStateDeleted };
      },
    },
    // S2 (#43) added a second identity sweep to the same job. Stubbed to "nothing
    // to delete" so these tests keep speaking only about the login-state half.
    identity_assertion_ids: { deleteMany: async () => ({ count: 0 }) },
  };
}

describe("retention purge covers identity_login_state (Q-3)", () => {
  test("the purge sweeps expired login states and reports the count", async () => {
    const db = fakeDb({ loginStateDeleted: 4 });
    const result = await purge({ db });

    expect(db.calls.loginStateDeleteWhere).not.toBeNull();
    expect(result.loginStatesPurged).toBe(4);
  });

  test("it deletes by EXPIRY only — a consumed row inside its TTL survives", async () => {
    const db = fakeDb();
    await purge({ db });

    // Sweeping consumed rows early would erase the difference between a replay
    // and an expiry, which is the whole reason consume() sets a flag instead of
    // deleting the row.
    const where = db.calls.loginStateDeleteWhere;
    expect(where).toHaveProperty("expiresAt");
    expect(where).not.toHaveProperty("consumedAt");
  });

  test("login states are swept even when the audit window is unusable", async () => {
    // The audit purge fails closed on a bad window and deletes nothing. That
    // must not also stop the login-state sweep: they are unrelated, and an
    // operator with no audit retention set would otherwise grow this table
    // forever.
    const db = fakeDb({ loginStateDeleted: 2 });
    db.system_settings.findFirst = async () => ({ value: "not-a-number" });

    const result = await purge({ db });
    expect(result.skipped).toBe(true);
    expect(result.purged).toBe(0);
    expect(result.loginStatesPurged).toBe(2);
  });

  test("the scheduled job reports both counts", async () => {
    const db = fakeDb({ loginStateDeleted: 1 });
    const result = await handlers["retention.purge@1"]({ traceId: "t-1", db });
    expect(result.loginStatesPurged).toBe(1);
  });
});
