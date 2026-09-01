const express = require("express");
const supertest = require("supertest");
const {
  BoundedMemoryStore,
  bearerKey,
  canonicalIp,
  loginAccountRateLimit,
  resetRequestControls,
} = require("../../../utils/middleware/requestControls");

function request(address, authorization = "") {
  return {
    socket: { remoteAddress: address },
    get: jest.fn((name) =>
      name.toLowerCase() === "authorization" ? authorization : undefined
    ),
  };
}

test("canonicalizes IPv4-mapped addresses and IPv6 /64 buckets", () => {
  expect(canonicalIp(request("::ffff:127.0.0.1"), true)).toBe("127.0.0.1");
  expect(canonicalIp(request("2001:db8:1:2::1"), true)).toBe(
    canonicalIp(request("2001:db8:1:2::ffff"), true)
  );
});

test("uses an HMAC bucket instead of storing bearer key material", () => {
  const secret = "apw_live_sensitive-key";
  const key = bearerKey(request("127.0.0.1", `Bearer ${secret}`));
  expect(key).not.toContain(secret);
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("bounds attacker-controlled limiter keys", async () => {
  const store = new BoundedMemoryStore(10);
  store.init({ windowMs: 60_000 });
  await Promise.all(
    Array.from({ length: 100_000 }, (_, index) =>
      store.increment(`key-${index}`)
    )
  );
  expect(store.hits.size).toBeLessThanOrEqual(11);
});

test("clears request control limits between HTTP suites", async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/request-token",
    loginAccountRateLimit,
    (_request, response) => response.sendStatus(401)
  );

  let response;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    response = await supertest(app)
      .post("/api/request-token")
      .send({ username: "reset-test" });
    if (response.status === 429) break;
  }
  expect(response.status).toBe(429);

  await resetRequestControls();

  await supertest(app)
    .post("/api/request-token")
    .send({ username: "reset-test" })
    .expect(401);
});
