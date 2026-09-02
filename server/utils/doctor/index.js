/**
 * O2a (#74) — installer preflight checks.
 *
 * Two callers with different jobs but one list: `scripts/doctor.js`, which an
 * operator runs on demand, and `docker-entrypoint.sh`, which runs it on every
 * boot before `prisma migrate deploy`. Running it before the migration is the
 * point: #61's migration creates a pg_trgm index, and a CREATE EXTENSION that
 * fails leaves the database in a failed-migration state that blocks every later
 * migration (§7.13). After the migration, this is a post-mortem.
 *
 * Imports are deliberately shallow — `pg`, `fs`, and #61's locale probe. Nothing
 * here may reach `apiKeySecurity` (which throws at import when API_KEY_PEPPER is
 * missing) or the boot tree, because a missing pepper is one of the things this
 * reports.
 */
const fs = require("fs");
const { Client } = require("pg");
const { thaiTrigramSupport } = require("../chatSearch/localeSupport");

// pg_trgm is unconditional: migration 20260902100000 creates gin_trgm_ops
// indexes on every install, so a database that cannot have it cannot migrate.
//
// `vector` is NOT. The default VECTOR_DB is lancedb (utils/helpers/index.js:88),
// which stores vectors on disk and never touches PostgreSQL; no migration
// creates the extension either. It matters only when the operator has chosen
// `VECTOR_DB=pgvector` (utils/helpers/index.js:117). Demanding it always would
// block the boot of every default install on stock `postgres:16`, which does
// not ship pgvector — including this project's own CI.
const ALWAYS_REQUIRED_EXTENSIONS = ["pg_trgm"];
const PGVECTOR_EXTENSION = "vector";

/** The one spelling `getVectorDbClass` accepts (utils/helpers/index.js:89). */
const PGVECTOR_SELECTION = "pgvector";

/** Did the operator MEAN pgvector, whatever they typed? */
const meansPgvector = (vectorDb) =>
  String(vectorDb ?? "").trim().toLowerCase() === PGVECTOR_SELECTION;

/**
 * Which extensions this instance actually needs, given its configuration.
 *
 * Intent, not exact spelling: `VECTOR_DB=PGVECTOR` does not reach the pgvector
 * provider (see checkVectorDbSpelling) but it does tell us what the operator
 * wants, and the doctor's job is to check the install they are trying to build.
 */
function requiredExtensions(vectorDb = process.env.VECTOR_DB) {
  return meansPgvector(vectorDb)
    ? [...ALWAYS_REQUIRED_EXTENSIONS, PGVECTOR_EXTENSION]
    : [...ALWAYS_REQUIRED_EXTENSIONS];
}

/**
 * `getVectorDbClass` switches on the RAW string (utils/helpers/index.js:88-89),
 * so `VECTOR_DB=PGVECTOR` matches no case, falls to the default arm, and quietly
 * returns LanceDB — one `[ENV ERROR]` line at boot and then an instance storing
 * vectors somewhere the operator did not choose.
 *
 * Catching exactly this is what a preflight is for: the configuration is
 * plausible, the server starts, nothing throws, and the mistake only shows up
 * as documents that are not where they should be.
 */
function checkVectorDbSpelling(vectorDb) {
  const raw = String(vectorDb ?? "");
  if (!meansPgvector(raw) || raw === PGVECTOR_SELECTION) {
    return result(
      "config.vector_db",
      true,
      raw === "" ? "VECTOR_DB is not set; the default vector store is LanceDB." : `VECTOR_DB is ${raw}.`
    );
  }
  return result(
    "config.vector_db",
    false,
    `VECTOR_DB is "${raw}", which no provider matches: the selection is compared as a raw string, so this falls through to the default and the app will silently store vectors in LanceDB instead of PostgreSQL.`
  );
}
const REQUIRED_SECRETS = [
  "JWT_SECRET",
  "SIG_KEY",
  "SIG_SALT",
  "API_KEY_PEPPER",
];
// AUTH_TOKEN is deliberately not here. It is the operator's single-user
// password, and its ABSENCE is the correct state of a fresh install and of every
// "just me, no password" instance (validatedRequest.js:29-36). Requiring it
// would block the boot of a correctly-installed system.

const MIN_SERVER_VERSION_NUM = 160000;

/**
 * Every check, in the order an operator should read them. `level` is fixed per
 * check rather than decided at runtime: whether a failure can be worked around
 * is a property of the check, not of how badly it failed.
 */
const CHECKS = [
  {
    id: "db.reachable",
    level: "block",
    remedy:
      "Check DATABASE_URL, and that the database accepts connections from this container. With an external PostgreSQL, run the doctor with --no-deps so it reports the connection failure instead of waiting on the bundled postgres healthcheck.",
  },
  {
    id: "db.version",
    level: "block",
    remedy:
      "Upgrade the server to PostgreSQL 16 or newer. Migration 20260902100000 calls pg_input_is_valid, which landed in 16 and is not guarded by a version check, and it creates gin_trgm_ops indexes in SCHEMA public. On 15 the migration fails with a syntax-level error that never mentions a version.",
  },
  {
    id: "ext.available",
    level: "block",
    remedy: `Install the missing extension package on the database SERVER. pg_trgm ships with PostgreSQL's contrib package; \`vector\` (pgvector) is a separate install and is only needed when VECTOR_DB=pgvector. This is not a permission problem — a role cannot be granted an extension the server does not ship.`,
  },
  {
    id: "ext.permitted",
    level: "block",
    remedy: `Have a superuser run CREATE EXTENSION IF NOT EXISTS <name>; for the extension named above, or grant the application role the right to create it.`,
  },
  {
    id: "env.writable",
    level: "block",
    remedy:
      "The container must own the mounted .env, because the installer replaces it by rename. Start compose as UID=$(id -u) GID=$(id -g) docker compose up, or chown the file on the host to the uid the container runs as. Note that ${UID:-1000} in docker-compose.yml resolves to 1000 on every machine, because UID is a shell variable the shell does not export.",
  },
  {
    id: "secrets.present",
    level: "block",
    remedy:
      "Run the installer's secret generation (scripts/ensure-secrets.js), which the entrypoint does before this check. If a key is still missing afterwards, the .env could not be written — see env.writable, which reports that separately because the fix is different.",
  },
  {
    id: "storage.writable",
    level: "block",
    remedy:
      "Create STORAGE_DIR and make it writable by the container's uid. Without it the instance cannot persist documents or vector data.",
  },
  {
    id: "config.vector_db",
    level: "block",
    remedy: `Set VECTOR_DB=${PGVECTOR_SELECTION} exactly — all lower case, no surrounding spaces. The provider selection is a raw string comparison, so any other spelling silently selects LanceDB.`,
  },
  {
    id: "db.locale",
    level: "warn",
    remedy:
      "Thai chat search still returns correct results, but scans the table instead of using its index. A database's collation is fixed at creation, so the repair is to recreate it with CREATE DATABASE ... LC_CTYPE 'en_US.UTF-8' LC_COLLATE 'en_US.UTF-8' TEMPLATE template0 and reindex. English is unaffected; this never blocks the install.",
  },
];

const CHECK_IDS = CHECKS.map((check) => check.id);
const byId = (id) => CHECKS.find((check) => check.id === id);
const levelOf = (id) => byId(id)?.level ?? null;
const remedyOf = (id) => byId(id)?.remedy ?? null;

const result = (id, ok, detail) => ({
  id,
  level: levelOf(id),
  ok,
  detail,
  remedy: remedyOf(id),
});

/**
 * Adapter so #61's thaiTrigramSupport can run over a plain pg client. The probe
 * SQL lives there and is not restated here: two copies of it would drift, and
 * the whole finding is about a query whose result depends on the database's
 * LC_CTYPE rather than on the query text.
 */
const prismaLike = (client) => ({
  $queryRawUnsafe: (sql, ...params) =>
    client.query(sql, params).then((res) => res.rows),
});

/** Can the installer replace this file by rename? */
function checkEnvWritable({ envPath, uid }) {
  const dir = require("path").dirname(envPath);

  // The directory first: writeEnvFileAtomic writes a temp file and renames it,
  // so the directory is what it actually writes to. It also skips its own
  // guards entirely when the target does not exist (ENOENT), which means a
  // read-only directory is invisible to it and surfaces as a rename failure
  // mid-boot rather than as a refusal.
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    return result(
      "env.writable",
      false,
      `The directory holding the .env file is not writable by this process: ${dir}. The installer replaces the file by renaming a temporary file into this directory, so directory permission is what it needs.`
    );
  }

  let stats = null;
  try {
    stats = fs.lstatSync(envPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      return result("env.writable", false, `Cannot stat ${envPath}: ${error.message}`);
    }
  }

  // Absent is fine — the installer creates it, and the directory check above is
  // what decides whether it can.
  if (stats === null) {
    return result(
      "env.writable",
      true,
      `${envPath} does not exist yet; the directory is writable, so the installer can create it.`
    );
  }

  if (stats.isSymbolicLink()) {
    return result(
      "env.writable",
      false,
      `${envPath} is a symlink. The installer refuses to follow it, because that would write instance secrets to a file chosen by whoever created the link.`
    );
  }

  if (stats.uid !== uid) {
    return result(
      "env.writable",
      false,
      `This process runs as uid ${uid}, but ${envPath} belongs to uid ${stats.uid}. The installer refuses to write a file it does not own, so the secrets cannot be persisted.`
    );
  }

  return result("env.writable", true, `${envPath} is owned by uid ${uid}.`);
}

function checkSecrets({ envPath }) {
  const body = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const assigned = new Set();
  for (const line of body.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*\S/.exec(line);
    if (match) assigned.add(match[1]);
  }
  const missing = REQUIRED_SECRETS.filter(
    (key) => !assigned.has(key) && !process.env[key]
  );
  return missing.length === 0
    ? result(
        "secrets.present",
        true,
        `All four instance secrets are set: ${REQUIRED_SECRETS.join(", ")}.`
      )
    : result(
        "secrets.present",
        false,
        `Missing instance secret(s): ${missing.join(", ")}.`
      );
}

function checkStorage({ storageDir }) {
  if (!storageDir) {
    return result("storage.writable", false, "STORAGE_DIR is not set.");
  }
  try {
    // accessSync, not write-then-delete: a probe file races a second container
    // starting at the same moment, and a failed cleanup would leave litter in
    // the operator's data directory.
    fs.accessSync(storageDir, fs.constants.W_OK | fs.constants.X_OK);
    return result("storage.writable", true, `${storageDir} is writable.`);
  } catch (error) {
    return result(
      "storage.writable",
      false,
      `${storageDir} is not writable by this process: ${error.code || error.message}.`
    );
  }
}

/**
 * #61's finding, asked at install time.
 *
 * The probe needs pg_trgm to answer, and on a fresh database the extension is
 * not installed yet — the migration installs it. So a failed probe has two
 * quite different causes, and reporting both as "your locale is wrong" would
 * send the operator to recreate a database that is perfectly fine. Read the
 * ctype directly (which always works) and only then decide which message the
 * finding deserves.
 */
async function checkLocale(client) {
  const { rows } = await client.query(
    "SELECT datctype FROM pg_database WHERE datname = current_database()"
  );
  const ctype = rows[0]?.datctype ?? "unknown";

  const { rows: ext } = await client.query(
    "SELECT installed_version FROM pg_available_extensions WHERE name = 'pg_trgm'"
  );
  if (!ext.length || ext[0].installed_version === null) {
    // Undecidable, not failing. Reported as ok so it does not look like a
    // finding the operator must act on: the migration installs pg_trgm, and the
    // boot report in utils/chatSearch/localeSupport.js asks again afterwards.
    return result(
      "db.locale",
      true,
      `LC_CTYPE is ${ctype}. pg_trgm is not installed yet, so Thai trigram support cannot be measured here; the server re-checks it at boot once the migration has installed the extension.`
    );
  }

  const locale = await thaiTrigramSupport({ db: prismaLike(client) });
  return result(
    "db.locale",
    locale.supported === true,
    locale.supported === true
      ? `LC_CTYPE is ${locale.ctype}; Thai text produces ${locale.trigrams} trigrams, so the search index works.`
      : `LC_CTYPE is ${locale.ctype ?? ctype}; Thai text produces no trigrams${locale.error ? ` (${locale.error})` : ""}. Thai chat search returns correct results, but by scanning the table instead of using its index.`
  );
}

async function checkExtensions(client, needed) {
  const available = [];
  const unavailable = [];
  for (const name of needed) {
    const { rows } = await client.query(
      "SELECT installed_version FROM pg_available_extensions WHERE name = $1",
      [name]
    );
    if (rows.length === 0) unavailable.push(name);
    else available.push({ name, installed: rows[0].installed_version !== null });
  }

  const availability =
    unavailable.length === 0
      ? result(
          "ext.available",
          true,
          `The server ships every extension this configuration needs: ${needed.join(", ")}.${
            needed.includes(PGVECTOR_EXTENSION)
              ? ""
              : ` \`${PGVECTOR_EXTENSION}\` is not checked, because VECTOR_DB is not pgvector; set VECTOR_DB=pgvector and re-run if you intend to store vectors in PostgreSQL.`
          }`
        )
      : result(
          "ext.available",
          false,
          `The database server does not ship: ${unavailable.join(", ")}. This is a server package problem, not a permission problem.`
        );

  if (unavailable.length > 0) {
    return [
      availability,
      result(
        "ext.permitted",
        false,
        "Not checked: an extension the server does not ship cannot be created by anyone.",
      ),
    ];
  }

  const installed = available.filter((e) => e.installed).map((e) => e.name);
  const toProbe = available.filter((e) => !e.installed).map((e) => e.name);

  // `CREATE EXTENSION IF NOT EXISTS` on a database that already has the
  // extension is a no-op that returns success without touching permissions —
  // it would report a privilege the role may not have. So probe only what is
  // genuinely absent, and report the rest as already installed.
  const denied = [];
  for (const name of toProbe) {
    try {
      await client.query("BEGIN");
      await client.query(`CREATE EXTENSION "${name}"`);
    } catch (error) {
      denied.push(`${name} (${error.code || error.message})`);
    } finally {
      await client.query("ROLLBACK");
    }
  }

  // The two halves are reported as two different claims, because they are.
  // Probing establishes that the role MAY create the extension. An extension
  // that is already installed establishes only that it is there — nobody tested
  // whether this role could have created it, and nobody needs to, since it will
  // not be created again. Wording them alike would report a verified privilege
  // that was never verified.
  const parts = [];
  if (installed.length)
    parts.push(
      `already installed, so no permission was needed or tested: ${installed.join(", ")}`
    );
  if (toProbe.length)
    parts.push(
      `permission verified by creating and rolling back, which writes inside a transaction that is rolled back so nothing is left behind: ${toProbe.join(", ")}`
    );

  return [
    availability,
    denied.length === 0
      ? result("ext.permitted", true, `${parts.join("; ")}.`)
      : result(
          "ext.permitted",
          false,
          `Cannot create: ${denied.join(", ")}. ${parts.join("; ")}.`
        ),
  ];
}

/**
 * @param {{databaseUrl?: string, envPath?: string, storageDir?: string, uid?: number}} input
 * @returns {Promise<Array<{id:string,level:string,ok:boolean,detail:string,remedy:string}>>}
 */
async function runChecks({
  vectorDb = process.env.VECTOR_DB,
  databaseUrl = process.env.DATABASE_URL,
  envPath = process.env.ENV_FILE_PATH ||
    require("path").join(__dirname, "../../.env"),
  storageDir = process.env.STORAGE_DIR,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
} = {}) {
  const localChecks = [
    checkVectorDbSpelling(vectorDb),
    checkEnvWritable({ envPath, uid }),
    checkSecrets({ envPath }),
    checkStorage({ storageDir }),
  ];

  const client = new Client({ connectionString: databaseUrl });
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    // Everything downstream of the connection reports FAILED, never ok. A
    // check that could not run must not report success — that is precisely how
    // a doctor comes to lie about a database it never reached.
    const unreachable =
      "Not checked: the database could not be reached, so this check could not run.";
    return order([
      result("db.reachable", false, `Cannot connect: ${error.message}`),
      result("db.version", false, unreachable),
      result("ext.available", false, unreachable),
      result("ext.permitted", false, unreachable),
      result("db.locale", false, unreachable),
      ...localChecks,
    ]);
  }

  try {
    const { rows } = await client.query("SHOW server_version_num");
    const versionNum = Number(rows[0].server_version_num);
    const version = result(
      "db.version",
      versionNum >= MIN_SERVER_VERSION_NUM,
      `server_version_num is ${versionNum}; the minimum is ${MIN_SERVER_VERSION_NUM} (PostgreSQL 16).`
    );

    const extensions = await checkExtensions(client, requiredExtensions(vectorDb));

    const localeCheck = await checkLocale(client);

    return order([
      result("db.reachable", true, `Connected to ${maskUrl(databaseUrl)}.`),
      version,
      ...extensions,
      localeCheck,
      ...localChecks,
    ]);
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

/** Keep the declared reading order regardless of the order results were produced. */
const order = (results) =>
  CHECK_IDS.map((id) => results.find((r) => r.id === id)).filter(Boolean);

/** Never print a password, even in a "connected" message. */
function maskUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return "the configured DATABASE_URL";
  }
}

/** Warnings never stop a boot; a single blocking failure does. */
const exitCodeFor = (results) =>
  results.some((r) => r.level === "block" && !r.ok) ? 1 : 0;

module.exports = {
  CHECKS,
  CHECK_IDS,
  ALWAYS_REQUIRED_EXTENSIONS,
  PGVECTOR_EXTENSION,
  requiredExtensions,
  meansPgvector,
  // Exported for the test that drives the "server does not ship it" branch:
  // reaching it through runChecks would need a PostgreSQL missing an extension
  // it actually has, which is the one situation a dev box cannot arrange.
  checkExtensions,
  REQUIRED_SECRETS,
  MIN_SERVER_VERSION_NUM,
  levelOf,
  remedyOf,
  runChecks,
  exitCodeFor,
};
