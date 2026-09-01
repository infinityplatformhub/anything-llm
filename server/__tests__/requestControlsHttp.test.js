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
