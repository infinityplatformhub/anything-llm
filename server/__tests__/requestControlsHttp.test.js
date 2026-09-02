const express = require("express");
const request = require("supertest");

function loadControls(env = {}) {
  jest.resetModules();
  Object.assign(process.env, env);
  return require("../utils/middleware/requestControls");
}

function appWith(...middleware) {
  const app = express();
  app.use(express.json());
  app.post("/api/request-token", middleware, (_request, response) =>
    response.status(200).json({ online: true })
  );
  return app;
}

afterEach(() => {
  for (const name of [
    "IP_ALLOWLIST",
    "LOGIN_ACCOUNT_RATE_LIMIT_MAX",
    "LOGIN_IP_RATE_LIMIT_MAX",
    "LOGIN_RATE_LIMIT_WINDOW_MS",
  ])
    delete process.env[name];
});

test("locks login tuple before valid credentials reach handler", async () => {
  const { loginAccountRateLimit } = loadControls({
    LOGIN_ACCOUNT_RATE_LIMIT_MAX: "2",
    LOGIN_IP_RATE_LIMIT_MAX: "20",
  });
  const app = appWith(loginAccountRateLimit);
  const variants = [" Victim ", "victim", "VICTIM"];
  const responses = [];
  for (const username of variants)
    responses.push(
      await request(app)
        .post("/api/request-token")
        .send({ username, password: "correct-on-final-attempt" })
    );
  expect(responses.map(({ status }) => status)).toEqual([200, 200, 429]);
});

test("ignores forwarding headers for allowlist decisions", async () => {
  const { ipAllowlist } = loadControls({ IP_ALLOWLIST: "203.0.113.7/32" });
  const response = await request(appWith(ipAllowlist))
    .post("/api/request-token")
    .set("X-Forwarded-For", "203.0.113.7")
    .set("X-Real-IP", "203.0.113.7")
    .set("Forwarded", "for=203.0.113.7")
    .set("CF-Connecting-IP", "203.0.113.7")
    .set("True-Client-IP", "203.0.113.7");
  expect(response.status).toBe(403);
});

test("allows empty config and fails closed for malformed CIDR", async () => {
  let controls = loadControls({ IP_ALLOWLIST: "" });
  expect(
    (await request(appWith(controls.ipAllowlist)).post("/api/request-token"))
      .status
  ).toBe(200);
  controls = loadControls({ IP_ALLOWLIST: "127.0.0.1/not-a-prefix" });
  expect(
    (await request(appWith(controls.ipAllowlist)).post("/api/request-token"))
      .status
  ).toBe(403);
});

// issue 77: the limit is read PER REQUEST, not frozen at module load.
//
// RED-first: written before the fix.
//
// Every limiter is a module-level `const`, so `integerEnv` ran once with
// whatever `process.env` held the first time this module was required in the
// process. An operator who raises INVITE_RATE_LIMIT_MAX sees no change until
// they restart — and nothing tells them that, so the setting looks broken
// rather than deferred.
//
// `windowMs` is deliberately NOT covered here: express-rate-limit hands it to
// the store at init() and BoundedMemoryStore caches it to compute every entry's
// resetTime, so changing it mid-flight would give old and new entries different
// windows. That one stays load-time by ruling.
describe("issue 77: the rate limit follows the environment", () => {
  test("raising the limit takes effect without reloading the module", async () => {
    const { inviteRateLimit } = loadControls({ INVITE_RATE_LIMIT_MAX: "1" });
    const app = appWith(inviteRateLimit);

    // The configured ceiling of 1: the second request is refused.
    expect((await request(app).post("/api/request-token")).status).toBe(200);
    expect((await request(app).post("/api/request-token")).status).toBe(429);

    // The operator raises the ceiling on the SAME running process — no reload,
    // because in production there is none short of a restart.
    process.env.INVITE_RATE_LIMIT_MAX = "50";

    // Which is the whole point: the limiter must now consult the new value.
    // Frozen at load, this stays 429 forever.
    expect((await request(app).post("/api/request-token")).status).toBe(200);
  });

  test("lowering the limit takes effect too, and refuses immediately", async () => {
    // The direction that matters under attack: an operator tightening a limit
    // during an incident cannot wait for a restart window.
    const { inviteRateLimit } = loadControls({ INVITE_RATE_LIMIT_MAX: "50" });
    const app = appWith(inviteRateLimit);

    expect((await request(app).post("/api/request-token")).status).toBe(200);

    process.env.INVITE_RATE_LIMIT_MAX = "1";
    expect((await request(app).post("/api/request-token")).status).toBe(429);
  });

  test("an unset or malformed value still falls back to the built-in default", async () => {
    // Reading per request must not turn a typo into an unlimited endpoint. The
    // fallback is the same one `integerEnv` has always applied — the change is
    // WHEN it is consulted, not WHAT it decides.
    const { inviteRateLimit } = loadControls({ INVITE_RATE_LIMIT_MAX: "10" });
    const app = appWith(inviteRateLimit);

    process.env.INVITE_RATE_LIMIT_MAX = "not-a-number";
    // 30 is the built-in default for this limiter; one request must pass.
    expect((await request(app).post("/api/request-token")).status).toBe(200);

    delete process.env.INVITE_RATE_LIMIT_MAX;
    expect((await request(app).post("/api/request-token")).status).toBe(200);
  });

  test("QA-3's probe: a limit raised after load is honoured", async () => {
    // QA-3's independently-written RED, kept as a regression because it
    // exercises a DIFFERENT limiter — loginAccountRateLimit, keyed on
    // ip+username — from the cases above, which use inviteRateLimit, keyed on
    // ip. One limiter consulting the environment late would not prove the rest
    // do; they are separate `limiter()` calls.
    //
    // Their measured failure before the fix: 200,200,429,429,429 — refused on
    // the third, honouring the frozen 2 while the environment already said 5.
    jest.resetModules();
    process.env.LOGIN_ACCOUNT_RATE_LIMIT_MAX = "2";
    const {
      loginAccountRateLimit,
    } = require("../utils/middleware/requestControls");

    process.env.LOGIN_ACCOUNT_RATE_LIMIT_MAX = "5";

    const app = appWith(loginAccountRateLimit);
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt++)
      statuses.push(
        (
          await request(app)
            .post("/api/request-token")
            .send({ username: "victim", password: "x" })
        ).status
      );

    // All five pass under the raised ceiling; a refusal would be the sixth.
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });
});
