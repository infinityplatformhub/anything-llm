/**
 * O5b (#94) — the diagnostic bundle behind `doctor --bundle`.
 *
 * THREAT MODEL, first, because it decides every other choice in this file.
 *
 * The bundle is A FILE, and files get shared. It will be attached to a GitHub
 * issue, dropped in a support email, pasted into a chat. That is the threat —
 * not an attacker breaching the server. An operator who generates one is, by
 * intent, about to hand it to a stranger.
 *
 * Two consequences:
 *
 *  1. Redaction happens ON ASSEMBLY, not on delivery. There is no second chance
 *     once the file exists on disk; the same reasoning as redaction.js redacting
 *     on write rather than sweeping the table later.
 *  2. The bar is not "no secret an attacker could use". It is "nothing the
 *     operator would be upset to find in a public issue" — which includes
 *     customer names, document filenames and user emails, none of which are
 *     secrets.
 *
 * NOTE ON PERMISSION: this module has no authorization check and needs none.
 * The CLI has no session — `docker compose run --rm anything-llm doctor
 * --bundle` runs as the container, with no HTTP request and no actor. The
 * control is that you already have a shell in the container, which is strictly
 * more than the bundle grants. The `diagnostics.export` permission belongs to
 * the HTTP/UI path (O5b-ui), where a request with an actor exists to check it.
 * Adding the row here, with nothing consulting it, would be an inert guard: it
 * would read as protection in review while protecting nothing.
 */
const os = require("os");
const { scrubValue } = require("../events/redaction");
const { KEY_MAPPING, stripUrlCredentials } = require("../helpers/updateENV");

/**
 * The environment the bundle reports, in TWO lists checked two different ways,
 * because "is this key safe to print" has two different answers depending on
 * whether the tree declares the key at all.
 *
 * An ALLOWLIST rather than `maskSecretValues` over everything. Masking all 214
 * declared keys is safe — an undeclared key masks fully — but the bundle's job
 * is to be USEFUL, and a file of 214 rows of `**********` is not. The pressure
 * would then be to unmask the obviously-safe ones one at a time, and that is
 * exactly how a denylist forms.
 *
 * DERIVED: keys `KEY_MAPPING` already declares. The guard test resolves each one
 * in that table and asserts `secret === false` — the strict comparison, not
 * `!== true`, because `secret: "url"` means "this value carries credentials in
 * its userinfo" and `!== true` would wave one through as ordinary configuration.
 */
const DERIVED_ENV_KEYS = Object.freeze([
  "VECTOR_DB",
  "LLM_PROVIDER",
  "EMBEDDING_ENGINE",
  "DISABLE_TELEMETRY",
]);

/**
 * UNDECLARED: keys `KEY_MAPPING` has no entry for, so nothing in the tree says
 * whether they are secret. Each carries the reason it is here, and the guard
 * test asserts both that the reason is non-empty and that the key is genuinely
 * absent from `KEY_MAPPING` — a key that later gains a declaration must move to
 * DERIVED and be checked against it rather than keep an exemption it no longer
 * needs.
 */
const UNDECLARED_ENV_KEYS = Object.freeze({
  NODE_ENV:
    "production vs development changes error handling, caching and several boot branches; it is the first thing to establish about a report.",
  SERVER_PORT:
    "a port number, and the answer to 'why can nothing reach it' often lives here.",
  STORAGE_DIR:
    "a path on the operator's own machine. The doctor already reports its writability; the bundle says which path that was.",
  ENABLE_HTTPS:
    "changes how the server binds, and is a common cause of a reachable-but-refusing install.",
  IP_ALLOWLIST:
    "decides whether /metrics and the API are reachable at all. Its VALUE is the operator's own network addresses, which is the point of reporting it.",
});

/**
 * `DATABASE_URL` is in NEITHER list, deliberately. It is not passed through and
 * it is not omitted: it is TRANSFORMED by `stripUrlCredentials` into host and
 * database without userinfo. Putting it in an allowlist would state that the
 * VALUE is safe to print, and it is not — only the transformed value is. It has
 * its own named case in `collectEnv` so that reading the lists cannot suggest
 * otherwise.
 *
 * `stripUrlCredentials` also falls back to a full mask when the value does not
 * parse: an unrecognised shape in an endpoint field might contain anything.
 */
const URL_SHAPED_KEYS = Object.freeze(["DATABASE_URL"]);

const ENV_ALLOWLIST = Object.freeze([
  ...DERIVED_ENV_KEYS,
  ...Object.keys(UNDECLARED_ENV_KEYS),
  ...URL_SHAPED_KEYS,
]);

function collectEnv(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    // Absent keys are omitted rather than reported as "": not set and set to
    // empty are different facts, and an operator reading the bundle to find out
    // which one they are in should not have them blurred together.
    if (value === undefined) continue;
    out[key] = URL_SHAPED_KEYS.includes(key)
      ? stripUrlCredentials(String(value))
      : value;
  }
  return out;
}

/**
 * Every `scheme://user:pass@` run inside a piece of free text, removed.
 *
 * TL-1 FINDING-1 (#94): `scrubValue` alone was NOT removing these. It appeared
 * to, because the EMAIL pattern happens to match `user:pass@db.internal` — and
 * only because that host contains a dot. Measured on the hosts this project
 * actually ships:
 *
 *   db.internal:5432   →  appuser:[redacted:email]:5432   (accident, not design)
 *   postgres:5432      →  appuser:sup3rsecret@postgres:5432   LEAKED IN FULL
 *   localhost:5432     →  appuser:sup3rsecret@localhost:5432  LEAKED IN FULL
 *
 * `postgres` is the host in docker-compose and `localhost` the host in CI, so
 * the two configurations we ship were both leaking. And even where the email
 * pattern did fire it removed only part: `Xq7!kR2#mN9$vL4` left `Xq7!kR2#mN9$`
 * behind, because the pattern starts matching at the last `.`-free run before
 * the `@`.
 *
 * `stripUrlCredentials` handles a string that IS a URL. This handles a URL
 * EMBEDDED in a sentence, which is the live shape: `safeQuery` returns
 * `error.message` verbatim, and the pg driver quotes the connection string in
 * its failure text — at exactly the moment someone runs `--bundle`.
 */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

/**
 * QA-2 FINDING-2 (#94): the pg driver names the account in plain prose, and in
 * more than one phrasing —
 *
 *   password authentication failed for user "appuser"
 *   role "qa2_leak_probe" does not exist
 *
 * — none of which matches a pattern in redaction.js. A database username is
 * neither a secret nor PII, so nothing was ever going to catch it; it is simply
 * something an operator would rather not publish beside their host.
 *
 * The three lead-ins are matched as a set rather than one at a time, for the
 * same reason redaction.js matches the `apw-*-` credential FAMILY rather than a
 * prefix list: the second phrasing was found only because a test drove a
 * connection failure that the first one did not cover.
 */
const PG_USER_PHRASE = /\b(for user|role|user) ("|')([^"']*)\2/gi;

/**
 * The one text path. Strip embedded credentials first, then run the pattern
 * scan over what is left — the order from TL-1 F3b, for the same reason: a
 * `user@host` left behind would match the EMAIL pattern and the output would
 * read as redacted while still naming the account.
 */
function scrubText(value, hits = new Set()) {
  // `hits` is threaded through rather than kept local: the bundle reports the
  // redaction CLASSES that fired, and a scrub that swallows its own hits makes
  // the bundle claim nothing was removed while removing things.
  if (typeof value !== "string") return scrubValue(value, hits, 0);
  // The userinfo run has NO password half in `user@host` — QA-2 FINDING-2. The
  // earlier pattern required a `:`, so `postgresql://qa2_leak_probe@localhost`
  // passed through with the account named. The password half is optional here.
  let stripped = value.replace(URL_CREDENTIALS, (_m, scheme) => {
    hits.add("url_credentials");
    return scheme;
  });
  stripped = stripped.replace(PG_USER_PHRASE, (_m, lead, quote) => {
    hits.add("db_username");
    return `${lead} ${quote}[redacted]${quote}`;
  });
  return scrubValue(stripped, hits, 0);
}

function collectVersions() {
  let appVersion = "unknown";
  try {
    appVersion = require("../../package.json").version ?? "unknown";
  } catch {
    // A bundle from an install broken enough to have no readable package.json
    // is still worth having; the missing field says so.
  }
  return {
    app: appVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

function collectResources() {
  return {
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    cpuCount: os.cpus().length,
  };
}

/**
 * Tables the bundle counts. COUNTS, NEVER ROWS.
 *
 * `event_logs` in particular: its `metadata` is redacted on write already, but
 * the rows are still the record of what every actor did, and `audit.read` is
 * super_admin-only because export is bulk egress of the highest-value data on
 * the instance (prisma/seeds/permissions.js:95). A count by `event` answers "is
 * anything failing" without shipping the trail.
 */
const COUNTED_TABLES = Object.freeze([
  "users",
  "workspaces",
  "workspace_documents",
  "workspace_chats",
  "event_logs",
]);

/**
 * Each query is individually tolerant. A bundle from a broken install is
 * exactly when this runs, so a missing table or a permission error must degrade
 * ONE row into an `error` string, not abandon the file. Reporting the failure is
 * itself diagnostic — "this table is not there" is often the answer.
 */
async function safeQuery(client, sql, params = [], hits = new Set()) {
  try {
    const { rows } = await client.query(sql, params);
    return { rows };
  } catch (error) {
    // NOT `error.message` verbatim. The pg driver quotes the connection string
    // in its failure text, and a connection failure is exactly the situation
    // that makes someone run `--bundle`.
    return { error: scrubText(String(error.message), hits) };
  }
}

async function collectDatabase(
  client,
  // The default reads process.env only when the caller injects nothing.
  // buildBundle always passes `env.DATABASE_URL`, so the seam the tests drive
  // is the same one production uses.
  { databaseUrl = process.env.DATABASE_URL, hits = new Set() } = {}
) {
  // The connection line is BUILT HERE from `stripUrlCredentials`, not borrowed
  // from the doctor's own `maskUrl`. `maskUrl` replaces the password and keeps
  // the USERNAME, which is right for a checklist an operator reads on their own
  // terminal and wrong for a file headed to a public issue: a database username
  // and an internal hostname match no PATTERN, so nothing downstream would catch
  // them. `stripUrlCredentials` drops the whole userinfo.
  //
  // The cost is the username, which anyone reading the bundle can look up in
  // their own environment if they need it.
  const connection = databaseUrl
    ? scrubText(stripUrlCredentials(String(databaseUrl)), hits)
    : "DATABASE_URL is not set";

  if (!client) return { connection, error: "database was not reachable" };

  const migrations = await safeQuery(
    client,
    `SELECT migration_name, applied_steps_count, finished_at, rolled_back_at
       FROM _prisma_migrations ORDER BY started_at DESC LIMIT 50`,
    [],
    hits
  );
  const version = await safeQuery(client, "SHOW server_version", [], hits);

  const counts = {};
  for (const table of COUNTED_TABLES) {
    // Table names come from the frozen list above, never from a caller, so the
    // interpolation cannot be reached by anything user-supplied. Identifiers
    // cannot be parameterised in PostgreSQL; a caller-supplied name here would
    // need quote_ident, and the right guard for that is not letting one in.
    const result = await safeQuery(
      client,
      `SELECT COUNT(*)::int AS n FROM "${table}"`,
      [],
      hits
    );
    counts[table] = result.error ? { error: result.error } : result.rows[0].n;
  }

  const eventCounts = await safeQuery(
    client,
    `SELECT event, COUNT(*)::int AS n FROM event_logs GROUP BY event ORDER BY n DESC LIMIT 50`,
    [],
    hits
  );

  return {
    connection,
    serverVersion: version.error
      ? { error: version.error }
      : scrubText(String(version.rows[0].server_version), hits),
    migrations: migrations.error
      ? { error: migrations.error }
      : migrations.rows.map((row) => ({
          ...row,
          migration_name: scrubText(String(row.migration_name), hits),
        })),
    counts,
    // The event NAME becomes a KEY here, and `scrubValue` walks values only —
    // it descends into an object's entries but never rewrites the entry names.
    // Measured: a seeded Thai national ID inside an event name survived the
    // whole-bundle scan while every other seeded marker was removed. This is
    // the same hole redaction.js closes by reporting `_droppedKeyCount` instead
    // of the dropped key names: a key is free text too. Scrub the name before
    // it becomes one. It is the only place in the bundle where data becomes a
    // key; anything added later that does the same needs the same call.
    eventCounts: eventCounts.error
      ? { error: eventCounts.error }
      : Object.fromEntries(
          eventCounts.rows.map((r) => [
            scrubText(String(r.event), hits),
            r.n,
          ])
        ),
  };
}

/**
 * Assemble the bundle. Returns a plain object; nothing here writes a file or
 * touches stdout, so the redaction test can call it directly rather than
 * through a process.
 *
 * The whole result passes through `scrubValue` before it is returned. Belt and
 * braces, for the same reason redaction.js runs both of its guards: an
 * allowlisted key still carries free text, a migration name is a filename
 * someone chose, and a `detail` string from a check quotes what it found.
 *
 * @returns {Promise<{bundle: object, redactions: string[]}>}
 */
async function buildBundle({ env = process.env, client = null, checks = [] } = {}) {
  const hits = new Set();
  const raw = {
    generatedAt: new Date().toISOString(),
    versions: collectVersions(),
    // The checks go through the same scrub as every other section. Their
    // `detail` strings quote what they FOUND — a connection string, a path, a
    // locale name — so "already redacted by construction" was wrong: they are
    // built from the same environment everything else here is redacted for.
    checks: checks.map((check) => ({
      ...check,
      // A check's `detail` and `remedy` are the live path for FINDING-1: they
      // quote the connection they just made.
      detail:
        typeof check.detail === "string" ? scrubText(check.detail, hits) : check.detail,
      remedy:
        typeof check.remedy === "string" ? scrubText(check.remedy, hits) : check.remedy,
    })),
    environment: collectEnv(env),
    database: await collectDatabase(client, {
      databaseUrl: env.DATABASE_URL,
      hits,
    }),
    resources: collectResources(),
  };

  const bundle = scrubValue(raw, hits, 0);
  // Naming the classes that fired, never what they matched. An operator seeing
  // `["email"]` knows something was removed and can say so when they share the
  // file; an operator seeing nothing would assume nothing was.
  bundle.redactions = [...hits].sort();
  return { bundle, redactions: bundle.redactions };
}

module.exports = {
  ENV_ALLOWLIST,
  DERIVED_ENV_KEYS,
  UNDECLARED_ENV_KEYS,
  URL_SHAPED_KEYS,
  COUNTED_TABLES,
  collectEnv,
  collectVersions,
  collectResources,
  collectDatabase,
  buildBundle,
  scrubText,
  // Exported so the allowlist guard test can assert every entry is declared
  // non-secret rather than re-deriving the table.
  KEY_MAPPING,
};
