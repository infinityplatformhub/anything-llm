#!/usr/bin/env node
/**
 * O2a (#74) — generate the instance's machine secrets before the server boots.
 *
 * Runs from `docker-entrypoint.sh`, not from inside the server process, because
 * `API_KEY_PEPPER` is validated at *import* (utils/apiKeySecurity/index.js:7-9).
 * Anything that generates it after Node has loaded the app is already too late.
 *
 * Four keys, not the five in INSTANCE_AUTH_KEYS. `AUTH_TOKEN` is deliberately
 * absent: it is the operator's single-user password, set from the onboarding
 * UserSetup step and documented as such in docker/.env.example. Writing a random
 * value there makes validatedRequest leave its no-auth branch and makes
 * /system/request-token compare the operator's password against bytes nobody has
 * ever seen — a permanent lockout with no reset path.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeEnvFileAtomic } = require("../utils/helpers/updateENV");

const GENERATED_KEYS = ["JWT_SECRET", "SIG_KEY", "SIG_SALT", "API_KEY_PEPPER"];

const envFilePath = () =>
  process.env.ENV_FILE_PATH || path.join(__dirname, "../.env");

/**
 * Which of our keys the file already assigns. Only the file counts, not
 * process.env: the entrypoint may carry a value that is never persisted, and
 * treating that as "already set" would leave the key missing after a restart.
 */
function assignedKeys(body) {
  const found = new Set();
  for (const line of body.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

function main() {
  const envPath = envFilePath();
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const present = assignedKeys(existing);
  const missing = GENERATED_KEYS.filter((key) => !present.has(key));

  // Nothing to do. Return before writing, so an unchanged install is not
  // rewritten and the backup notice is not reprinted on every boot — a notice
  // printed every time is a notice nobody reads.
  if (missing.length === 0) return 0;

  // 32 bytes as hex. apiKeySecurity requires >= 32 bytes of the STRING, so hex
  // (2 chars per byte) clears it with room to spare; base64 would not, at 32
  // bytes of entropy it is 44 chars but the check is on length, not entropy.
  const generated = missing
    .map((key) => `${key}=${crypto.randomBytes(32).toString("hex")}`)
    .join("\n");

  const body = existing.length && !existing.endsWith("\n")
    ? `${existing}\n${generated}\n`
    : `${existing}${generated}\n`;

  // writeEnvFileAtomic REFUSES by returning false (symlinked path, or a file
  // owned by another uid) rather than throwing. Ignoring the return value is
  // the failure this branch exists for: the boot would continue with secrets
  // that live only in this process, so every API key minted in that run stops
  // verifying at the next restart.
  if (writeEnvFileAtomic(envPath, body) !== true) {
    console.error(
      `[ensure-secrets] Could not write ${envPath}. The instance secrets were NOT persisted, so the boot is stopping here rather than running with secrets that vanish on restart.`
    );
    console.error(
      `[ensure-secrets] The refusal reason is printed above. The usual cause is ownership: the container runs as uid ${typeof process.getuid === "function" ? process.getuid() : "unknown"} and the mounted file belongs to someone else. Fix with 'chown' on the host file, or set UID/GID in docker/.env.`
    );
    return 1;
  }

  console.log(
    `[ensure-secrets] Generated ${missing.length} instance secret(s): ${missing.join(", ")}`
  );
  console.log(
    `[ensure-secrets] BACK THESE UP. They exist only in ${envPath}. Losing API_KEY_PEPPER invalidates every API key; losing SIG_KEY makes the credential store unreadable.`
  );
  return 0;
}

// ENSURE_SECRETS_NOOP lets a test require this file to prove it imports
// cleanly with API_KEY_PEPPER unset, without it writing anything.
if (require.main === module && !process.env.ENSURE_SECRETS_NOOP) {
  process.exit(main());
}

module.exports = { main, GENERATED_KEYS };
