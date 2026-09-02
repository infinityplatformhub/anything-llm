const crypto = require("crypto");
const ipaddr = require("ipaddr.js");
const { rateLimit } = require("express-rate-limit");

const MAX_KEYS = 10_000;
const LIMIT_MESSAGE = { error: "Too many requests. Try again later." };

// ponytail: in-process storage covers single-node deployment; replace with a
// shared bounded store before horizontal scaling.
class BoundedMemoryStore {
  constructor(maxKeys = MAX_KEYS) {
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(rawKey) {
    const now = Date.now();
    let key = rawKey;
    let entry = this.hits.get(key);
    if (entry?.resetTime.getTime() <= now) {
      this.hits.delete(key);
      entry = null;
    }
    if (!entry && this.hits.size >= this.maxKeys) {
      // ponytail: unseen keys share this fail-closed overflow bucket once the
      // cap is full; replace with a shared bounded store before multi-node use.
      key = "overflow";
      entry = this.hits.get(key);
    }
    if (!entry) {
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      this.hits.set(key, entry);
    }
    entry.totalHits += 1;
    return entry;
  }

  async decrement(key) {
    const entry = this.hits.get(key);
    if (entry) entry.totalHits = Math.max(0, entry.totalHits - 1);
  }

  async resetKey(key) {
    this.hits.delete(key);
  }

  async resetAll() {
    this.hits.clear();
  }
}

function socketAddress(request) {
  const raw = request.socket?.remoteAddress;
  if (!raw || !ipaddr.isValid(raw)) return null;
  let address = ipaddr.parse(raw);
  if (address.kind() === "ipv6" && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }
  return address;
}

function canonicalIp(request, groupV6 = false) {
  const address = socketAddress(request);
  if (!address) return "unknown";
  if (groupV6 && address.kind() === "ipv6") {
    const bytes = address.toByteArray();
    bytes.fill(0, 8);
    return ipaddr.fromByteArray(bytes).toNormalizedString() + "/64";
  }
  return address.toString();
}

function digest(value) {
  return crypto
    .createHmac(
      "sha256",
      process.env.RATE_LIMIT_HMAC_SECRET ||
        process.env.JWT_SECRET ||
        "approofworkspace-rate-limit"
    )
    .update(value)
    .digest("base64url");
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const requestControlStores = [];

function limiter({ windowEnv, limitEnv, windowMs, limit, keyGenerator }) {
  // ONE store per limiter, created here and never replaced. `resetRequestControls`
  // holds this exact object, and other suites call it in `beforeEach` — hand out
  // a fresh store per request and those resets would clear something nobody is
  // counting in, leaving state to leak between tests.
  const store = new BoundedMemoryStore();
  requestControlStores.push(store);
  return rateLimit({
    // issue 77: `windowMs` stays LOAD-TIME, deliberately. express-rate-limit
    // passes it to the store's `init()`, and BoundedMemoryStore keeps it to
    // compute every entry's `resetTime` — change it mid-flight and entries
    // created before and after expire on different schedules, with nothing
    // saying so. Restarting to change a window is an acceptable cost; windows
    // change far less often than limits.
    windowMs: integerEnv(windowEnv, windowMs),
    // The LIMIT, by contrast, is read per request. Frozen, an operator who
    // raises or lowers a ceiling sees no effect until the process restarts, and
    // nothing tells them the setting is merely deferred rather than broken.
    // Tightening a limit during an incident is exactly when waiting for a
    // restart window is least acceptable.
    limit: () => integerEnv(limitEnv, limit),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (_request, response) => response.status(429).json(LIMIT_MESSAGE),
    store,
    validate: false,
  });
}

async function resetRequestControls() {
  await Promise.all(requestControlStores.map((store) => store.resetAll()));
}

const ipKey = (request) => digest(`ip:${canonicalIp(request, true)}`);
const bearerKey = (request) => {
  const authorization = request.get("authorization") || "";
  return digest(`key:${authorization.replace(/^Bearer\s+/i, "")}`);
};
const loginKey = (request) => {
  const username = String(request.body?.username || "")
    .trim()
    .toLowerCase();
  return digest(`login:${canonicalIp(request, true)}:${username}`);
};

const loginIpRateLimit = limiter({
  windowEnv: "LOGIN_RATE_LIMIT_WINDOW_MS",
  limitEnv: "LOGIN_IP_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 30,
  keyGenerator: ipKey,
});
const loginAccountRateLimit = limiter({
  windowEnv: "LOGIN_RATE_LIMIT_WINDOW_MS",
  limitEnv: "LOGIN_ACCOUNT_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 5,
  keyGenerator: loginKey,
});
const apiIpRateLimit = limiter({
  windowEnv: "API_RATE_LIMIT_WINDOW_MS",
  limitEnv: "API_IP_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 600,
  keyGenerator: ipKey,
});
const apiKeyRateLimit = limiter({
  windowEnv: "API_RATE_LIMIT_WINDOW_MS",
  limitEnv: "API_KEY_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 600,
  keyGenerator: bearerKey,
});
const inviteRateLimit = limiter({
  windowEnv: "INVITE_RATE_LIMIT_WINDOW_MS",
  limitEnv: "INVITE_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 30,
  keyGenerator: ipKey,
});
// V9 (#61): chat search is the one chat route whose cost is not bounded by the
// caller's own history size — a short needle makes the planner walk a large
// candidate set. The history reads it sits beside return a bounded page and
// need no limiter of their own.
const chatSearchRateLimit = limiter({
  windowEnv: "CHAT_SEARCH_RATE_LIMIT_WINDOW_MS",
  limitEnv: "CHAT_SEARCH_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 60,
  keyGenerator: ipKey,
});
const embedHistoryRateLimit = limiter({
  windowEnv: "EMBED_RATE_LIMIT_WINDOW_MS",
  limitEnv: "EMBED_RATE_LIMIT_MAX",
  windowMs: 60_000,
  limit: 120,
  keyGenerator: ipKey,
});

let allowlistCache;
function parsedAllowlist() {
  const raw = process.env.IP_ALLOWLIST || "";
  if (allowlistCache?.raw === raw) return allowlistCache.entries;
  try {
    const entries = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [address, prefix] = entry.includes("/")
          ? ipaddr.parseCIDR(entry)
          : [ipaddr.parse(entry), null];
        const normalized =
          address.kind() === "ipv6" && address.isIPv4MappedAddress()
            ? address.toIPv4Address()
            : address;
        return [normalized, prefix];
      });
    allowlistCache = { raw, entries };
  } catch {
    allowlistCache = { raw, entries: null };
  }
  return allowlistCache.entries;
}

function ipAllowlist(request, response, next) {
  const entries = parsedAllowlist();
  if (entries?.length === 0) return next();
  if (!entries) return response.status(403).json({ error: "Access denied." });
  const source = socketAddress(request);
  if (!source) return response.status(403).json({ error: "Access denied." });
  const allowed = entries.some(([address, prefix]) => {
    if (address.kind() !== source.kind()) return false;
    return prefix === null
      ? address.toString() === source.toString()
      : source.match(address, prefix);
  });
  return allowed
    ? next()
    : response.status(403).json({ error: "Access denied." });
}

module.exports = {
  BoundedMemoryStore,
  apiIpRateLimit,
  apiKeyRateLimit,
  bearerKey,
  chatSearchRateLimit,
  canonicalIp,
  embedHistoryRateLimit,
  ipAllowlist,
  inviteRateLimit,
  loginAccountRateLimit,
  loginIpRateLimit,
  resetRequestControls,
};
