// #116 — /system/update-password rotates two credentials; when only one persists, the STORE is
// left holding one new value and one old.
//
// #104 (merged, `909e98b9a`) made that visible: `updateENV` now accumulates the persist error
// and the route answers `success: false` naming the key. What it does not do is undo the half
// that succeeded, and the operator's retry is not guaranteed — they may never retry.
//
// The state that leaves is not symmetric, and the dangerous order is the one this suite exists
// for. `validatedRequest.js:29-36` is a DISJUNCTION:
//
//     if (NODE_ENV === "development" || !AUTH_TOKEN || !JWT_SECRET) { next(); return; }
//
// so an absent AUTH_TOKEN opens the instance to everyone. `ensure-secrets.js` deliberately does
// NOT generate AUTH_TOKEN (writing random bytes there is a permanent lockout, ensure-secrets:9-19)
// — so if JWT_SECRET persisted and AUTH_TOKEN did not, the next boot comes up with no password
// at all while the operator believes they just set one.
//
// PMO/TL-1 ruling: compensate in the STORE ONLY — read both credentials before `updateENV`,
// and on a persist error naming either key restore both to what was read (`set` the old value,
// or `delete` when there was none). `process.env` is deliberately NOT rolled back: this process
// is already running on the new values, and unsetting them would break the live instance on top
// of losing the credential — that is #104's ruling and RF-5 pins it.
//
// Not a transaction: atomicity would have to live inside `updateENV`, which 213 settings share,
// and #84 already refused that shape. The compensation belongs to this route's pair.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "ci-only-api-key-pepper-32-bytes-minimum";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";
process.env.SIG_KEY = process.env.SIG_KEY || "a".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "b".repeat(64);

const express = require("express");
const request = require("supertest");

jest.mock("../../models/credentialStore", () => ({
  CredentialStore: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    keys: jest.fn(async () => []),
  },
  ALGORITHM: "aes-256-gcm",
  KEY_VERSION: 1,
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next(),
}));
jest.mock("../../utils/http", () => {
  const actual = jest.requireActual("../../utils/http");
  return { ...actual, multiUserMode: () => false };
});

const { CredentialStore } = require("../../models/credentialStore");
const { systemEndpoints } = require("../../endpoints/system");

const OLD_AUTH = "old-password-value";
const OLD_JWT = "old-jwt-secret-value";
const NEW_PASSWORD = "brand-new-password";

function appWithSystem() {
  const app = express();
  app.use(express.json());
  systemEndpoints(app);
  return app;
}

const updatePassword = () =>
  request(appWithSystem())
    .post("/system/update-password")
    .send({ usePassword: true, newPassword: NEW_PASSWORD });

/**
 * Drive the store: `stored` seeds what `get` returns, `failOn` names the envKey whose `set`
 * fails. Every call is recorded so a test can assert ORDER — which is how "read before write"
 * is distinguished from "read after write", a mutant that a fixture with no prior value would
 * otherwise pass (RF-2).
 */
function primeStore({ stored = {}, failOn = null } = {}) {
  const calls = [];
  CredentialStore.get.mockImplementation(async (envKey) => {
    calls.push({ op: "get", envKey });
    return stored[envKey] ?? null;
  });
  CredentialStore.set.mockImplementation(async (envKey, value) => {
    calls.push({ op: "set", envKey, value });
    if (envKey === failOn) return { envKey, error: "disk full" };
    stored[envKey] = value;
    return { envKey, error: null };
  });
  CredentialStore.delete.mockImplementation(async (envKey) => {
    calls.push({ op: "delete", envKey });
    delete stored[envKey];
    return true;
  });
  return { calls, stored };
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  // Set explicitly every time rather than left to whatever the previous test wrote.
  // `loadStoredCredentials` SKIPS any key already present in the environment, so a leaked
  // AUTH_TOKEN from an earlier test changes what a later one exercises — and the test that
  // breaks is not the one that leaked it.
  process.env.AUTH_TOKEN = OLD_AUTH;
  process.env.JWT_SECRET = OLD_JWT;
});
afterEach(() => {
  for (const key of ["AUTH_TOKEN", "JWT_SECRET"]) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

describe("#116 RF-1: a store that takes the first key and refuses the second is rolled back", () => {
  test("both credentials are back to their prior stored values", async () => {
    // The defect in one sentence: the store ends up holding one new value and one old. After
    // the fix it holds what it held before the attempt — the operator's retry starts from a
    // known state rather than from a half-applied one.
    const { stored } = primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    const response = await updatePassword();

    expect(response.body.success).toBe(false);
    expect(stored.AUTH_TOKEN).toBe(OLD_AUTH);
    expect(stored.JWT_SECRET).toBe(OLD_JWT);
  });

  test("the error names the key that failed", async () => {
    primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    const response = await updatePassword();

    expect(response.body.error).toMatch(/JWT_SECRET/);
  });

  test("the operator is told the running instance is on values that will not survive a restart", async () => {
    // Without this the message is "something failed", and the natural reading is "nothing
    // changed" — but the process IS running on the new values. An operator who walks away
    // believing the change did not take effect is surprised by the restart.
    primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    const response = await updatePassword();

    expect(response.body.error).toMatch(/restart/i);
  });
});

describe("#116 RF-2: the prior values are read BEFORE updateENV, not after", () => {
  test("a restore returns the value that was stored before the attempt", async () => {
    // The fixture seeds a prior value DIFFERENT from the new one on purpose. With a fixture
    // whose prior value is absent, a read-after-write implementation restores `null` and the
    // assertion still passes — the bug survives the test that was meant to catch it.
    const { stored } = primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    await updatePassword();

    expect(stored.AUTH_TOKEN).toBe(OLD_AUTH);
    expect(stored.AUTH_TOKEN).not.toBe(NEW_PASSWORD);
  });

  test("both reads happen before the first write", async () => {
    // Asserted on ORDER rather than on outcome, because outcome alone cannot separate
    // "read before" from "read after" for every fixture. This is the assertion the
    // read-after-write mutant fails.
    const { calls } = primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    await updatePassword();

    const firstWrite = calls.findIndex((call) => call.op === "set");
    const reads = calls
      .map((call, index) => ({ ...call, index }))
      .filter((call) => call.op === "get");
    expect(reads.map((read) => read.envKey).sort()).toEqual([
      "AUTH_TOKEN",
      "JWT_SECRET",
    ]);
    expect(reads.every((read) => read.index < firstWrite)).toBe(true);
  });
});

describe("#116: the finding this issue did not name — no prior AUTH_TOKEN", () => {
  test("a store with NO prior rows ends up with no rows, not one", async () => {
    // The dangerous order. AUTH_TOKEN persists, JWT_SECRET does not — or the reverse — and the
    // store is left holding exactly one row. On the next boot `ensure-secrets` regenerates
    // JWT_SECRET but deliberately NOT AUTH_TOKEN, so an instance whose store holds only
    // JWT_SECRET comes up with no password and `validatedRequest`'s disjunction lets every
    // request through unauthenticated — while the operator believes they set one.
    //
    // Restoring "no row" by DELETING is what closes it: the instance returns to its
    // pre-password state, which is passthrough — but that is the state the operator was
    // already in, not a new hole opened by a failed change.
    const { stored } = primeStore({ stored: {}, failOn: "AUTH_TOKEN" });

    const response = await updatePassword();

    expect(response.body.success).toBe(false);
    expect(stored).toEqual({});
  });

  test("the restore uses delete, not a write of empty string", async () => {
    // `CredentialStore.set` REFUSES an empty value ("a credential must have a value; delete
    // the row to clear it"), so a compensation that tried `set(key, "")` would fail silently
    // and leave the row it meant to remove.
    const { calls } = primeStore({ stored: {}, failOn: "AUTH_TOKEN" });

    await updatePassword();

    expect(calls.filter((call) => call.op === "delete").map((c) => c.envKey).sort()).toEqual([
      "AUTH_TOKEN",
      "JWT_SECRET",
    ]);
  });
});

describe("#116 RF-2b: with no prior AUTH_TOKEN row, BOTH keys end absent", () => {
  test("the store reads back null for both — the pre-password state, complete", async () => {
    // Separated from RF-2 because it asserts a different thing: RF-2 is about WHEN the prior
    // values are read; this is about what "restore" means when there was nothing to restore.
    // Asserted through `get` rather than by inspecting the fixture object, because `get` is
    // what the next boot uses — a compensation that left a row set to something falsy would
    // satisfy an object check and still hand the next boot a credential.
    primeStore({ stored: {}, failOn: "AUTH_TOKEN" });

    await updatePassword();

    expect(await CredentialStore.get("AUTH_TOKEN")).toBeNull();
    expect(await CredentialStore.get("JWT_SECRET")).toBeNull();
  });

  test("prior values come from the STORE, never from process.env", async () => {
    // Two bugs closed by one rule. `process.env.JWT_SECRET` is overwritten by `updateENV`
    // before any compensation runs, so reading the "prior" value from the environment would
    // capture the NEW secret. And during #115's hydrate window the environment is empty while
    // the store is not, so an env-sourced read would restore an absence over a real row.
    //
    // The environment is seeded to values that differ from the store on purpose: an
    // implementation reading process.env restores THOSE, and this fails.
    process.env.AUTH_TOKEN = "env-only-value-never-in-store";
    process.env.JWT_SECRET = "env-only-jwt-never-in-store";
    const { stored } = primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    await updatePassword();

    expect(stored.AUTH_TOKEN).toBe(OLD_AUTH);
    expect(stored.AUTH_TOKEN).not.toBe("env-only-value-never-in-store");
  });
});

describe("#116 RF-3: a successful rotation is untouched", () => {
  test("both keys are stored and no restore runs", async () => {
    // Positive control. Every assertion above is satisfied by a route that restores
    // unconditionally — which would make the feature impossible to use.
    const { stored, calls } = primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
    });

    const response = await updatePassword();

    expect(response.body.success).toBe(true);
    expect(stored.AUTH_TOKEN).toBe(NEW_PASSWORD);
    expect(stored.JWT_SECRET).not.toBe(OLD_JWT);
    // Two writes, no deletes, and no second write of the old value.
    expect(calls.filter((call) => call.op === "delete")).toHaveLength(0);
    expect(
      calls.filter((call) => call.op === "set" && call.value === OLD_AUTH)
    ).toHaveLength(0);
    // Exactly two writes: the rotation itself. A compensation that ran and happened to write
    // the same values would satisfy every assertion above and be invisible — counted, so it
    // is not.
    expect(calls.filter((call) => call.op === "set")).toHaveLength(2);
  });
});

describe("#116 RF-4: a restore that itself fails is reported, not thrown", () => {
  test("the response still says success:false and names both problems", async () => {
    // The compensation runs under the same conditions that just caused the failure, so it can
    // fail too. An exception here would 500 — losing the original error, which is the one
    // telling the operator which credential is not durable.
    const stored = { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT };
    CredentialStore.get.mockImplementation(async (envKey) => stored[envKey] ?? null);
    CredentialStore.set.mockImplementation(async (envKey, value) => {
      if (envKey === "JWT_SECRET") return { envKey, error: "disk full" };
      if (value === OLD_AUTH) return { envKey, error: "still full" }; // the restore
      stored[envKey] = value;
      return { envKey, error: null };
    });
    CredentialStore.delete.mockResolvedValue(false);

    const response = await updatePassword();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/JWT_SECRET/);
    expect(response.body.error).toMatch(/could not be restored|restore/i);
  });
});

describe("#116 RF-5: process.env is NOT rolled back", () => {
  test("both variables still hold the new values after the response", async () => {
    // #104's ruling, pinned. The running instance is already using these values; unsetting
    // them would break every authenticated request in flight and log the operator out of the
    // session they are making the change from — on top of the credential still being lost at
    // the next restart. Rolling back the STORE fixes durability; rolling back the ENV would
    // break the present to tidy the past.
    //
    // A future contributor adding an env rollback "for symmetry" fails here.
    primeStore({
      stored: { AUTH_TOKEN: OLD_AUTH, JWT_SECRET: OLD_JWT },
      failOn: "JWT_SECRET",
    });

    await updatePassword();

    expect(process.env.AUTH_TOKEN).toBe(NEW_PASSWORD);
    expect(process.env.JWT_SECRET).not.toBe(OLD_JWT);
    expect(process.env.JWT_SECRET).toBeTruthy();
  });
});
