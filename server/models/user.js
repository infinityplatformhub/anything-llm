const { emitAuditEvent } = require("../utils/events");
const { Prisma } = require("@prisma/client");
const {
  syncLegacyRoleGrant,
} = require("../utils/authorization/legacyRoleGrants");
const prisma = require("../utils/prisma");

/**
 * @typedef {Object} User
 * @property {number} id
 * @property {string} username
 * @property {string} password
 * @property {string} pfpFilename
 * @property {string} role
 * @property {boolean} suspended
 * @property {number|null} dailyMessageLimit
 */

/**
 * `suspended`, parsed from an explicit set — never truthiness, never a default.
 *
 * Returns 1, 0, or `null` for anything else. `null` means REFUSE, and the caller
 * turns it into `{success: false, error}` rather than throwing: this is a
 * malformed request, not a server fault.
 *
 * It was `Number(Boolean(value))`, and every non-empty string is truthy —
 * measured, `"0"`, `"false"`, `"no"`, `"[]"` and `"0.0"` all became 1, with only
 * `""` becoming 0. `{"suspended": "0"}` is what a JSON client sends to
 * UN-suspend, and combined with permanent revocation (see `revokeCredentialsFor`)
 * that is unrecoverable: the operator's un-suspend suspends the account again AND
 * destroys every key the user has.
 *
 * An unrecognised value is refused rather than assigned a side. Defaulting to 0
 * silently ignores a suspend the operator asked for; defaulting to 1 silently
 * destroys credentials. Both are invisible to the caller.
 *
 * Scope is this column only. `default: String(value)` is left alone — widening
 * the rule to every field is a different change with its own blast radius.
 */
function suspendedValue(value) {
  const token =
    typeof value === "string" ? value.trim().toLowerCase() : value;
  if (token === 1 || token === "1" || token === true || token === "true")
    return 1;
  if (token === 0 || token === "0" || token === false || token === "false")
    return 0;
  return null;
}

/**
 * Revoke the user's `api_keys` rows when they are offboarded.
 *
 * SUSPENSION ONLY. `User.delete` does not call this and gets no sweep: nothing
 * cleans up a deleted user's keys, because `api_keys.createdBy` has no foreign
 * key and the row outlives its owner. What stops a deleted user's key is the
 * READER — `keyGrantPrincipal` refuses a creator whose row is gone (TL-2
 * security review, pinned by the F5 fixture). Orphaned rows are #135's cleanup,
 * not an authorization gap.
 *
 * `api_keys` ONLY, and the other three credential tables are deliberately absent
 * because each is already safe at the reader: `browser_extension_api_keys` and
 * `desktop_mobile_devices` re-read `suspended` on every request and both carry a
 * real foreign key to `users`, and `temporary_auth_tokens` checks it at
 * `models/temporaryAuthToken.js:84`. Sweeping them would add writes that change
 * nothing.
 *
 * `revokedAt` is what `ApiKey.validate` consults (`models/apiKeys.js:91`), so
 * setting it is what actually stops the key rather than merely recording that it
 * should have stopped.
 *
 * REVOCATION IS PERMANENT. `revokedAt` is never cleared — not by un-suspending the
 * user, not by anything else. A key revoked during an offboarding stays dead even
 * if the account is restored, and the restored user mints a new one. The
 * alternative, reviving old secrets on un-suspension, means a credential that may
 * have been copied during the suspension silently works again.
 *
 * Already-revoked keys are left alone for the same reason: `revokedAt: null` in
 * the filter keeps the ORIGINAL timestamp, which is audit history. Re-stamping it
 * would rewrite when a key stopped working.
 *
 * Browser-extension keys need no equivalent: `validBrowserExtensionApiKey.js:27`
 * re-reads `suspended` on every request, and its key table has a real foreign key
 * to `users`.
 */
async function revokeCredentialsFor(userId, tx) {
  const { count } = await tx.api_keys.updateMany({
    where: { createdBy: Number(userId), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

const User = {
  usernameRegex: new RegExp(/^[a-z][a-z0-9._@-]*$/),
  writable: [
    // Used for generic updates so we can validate keys in request body
    "username",
    "password",
    "pfpFilename",
    "role",
    "suspended",
    "dailyMessageLimit",
    "bio",
  ],
  validations: {
    /**
     * Unix-style username regex:
     * - Must start with a lowercase letter
     * - Can contain lowercase letters, digits, underscores, hyphens, @ signs, and periods
     * - 2-64 characters long
     */
    username: (newValue = "") => {
      try {
        const username = String(newValue);
        if (username.length > 64)
          throw new Error("Username cannot be longer than 64 characters");
        if (username.length < 2)
          throw new Error("Username must be at least 2 characters");
        if (!User.usernameRegex.test(username))
          throw new Error(
            "Username must start with a lowercase letter and only contain lowercase letters, numbers, underscores, hyphens, and periods"
          );
        return username;
      } catch (e) {
        throw new Error(e.message);
      }
    },
    role: (role = "default") => {
      const VALID_ROLES = ["default", "admin", "manager"];
      if (!VALID_ROLES.includes(role)) {
        throw new Error(
          `Invalid role. Allowed roles are: ${VALID_ROLES.join(", ")}`
        );
      }
      return String(role);
    },
    dailyMessageLimit: (dailyMessageLimit = null) => {
      if (dailyMessageLimit === null) return null;
      const limit = Number(dailyMessageLimit);
      if (isNaN(limit) || limit < 1) {
        throw new Error(
          "Daily message limit must be null or a number greater than or equal to 1"
        );
      }
      return limit;
    },
    bio: (bio = "") => {
      if (!bio || typeof bio !== "string") return "";
      if (bio.length > 1000)
        throw new Error("Bio cannot be longer than 1,000 characters");
      return String(bio);
    },
  },
  // validations for the above writable fields.
  castColumnValue: function (key, value) {
    switch (key) {
      case "suspended": {
        // Returns `null` for an unrecognised value; `update` turns that into
        // `{success: false, error}`. See SUSPENDED_VALUES below.
        // An EXPLICIT SET, not truthiness and not a default.
        //
        // It was `Number(Boolean(value))`, and every non-empty string is truthy:
        // measured, `"0"`, `"false"`, `"no"`, `"[]"` and `"0.0"` all became 1,
        // with only `""` becoming 0. `{"suspended": "0"}` is what a JSON client
        // sends to UN-suspend, and combined with permanent revocation (see
        // `revokeCredentialsFor`) that is unrecoverable: the operator's
        // un-suspend suspends the account again AND destroys every key the user
        // has.
        //
        // An unrecognised value THROWS rather than picking a side. Defaulting to
        // 0 silently ignores a suspend the operator asked for; defaulting to 1
        // silently destroys credentials. Both are wrong in a way the caller
        // cannot see, and `update` turns the throw into `{success: false, error}`
        // — an answer.
        return suspendedValue(value);
      }
      case "dailyMessageLimit":
        return value === null ? null : Number(value);
      default:
        return String(value);
    }
  },

  filterFields: function (user = {}) {
    const {
      password: _password,
      web_push_subscription_config: _web_push_subscription_config,
      ...rest
    } = user;
    return { ...rest };
  },
  _identifyErrorAndFormatMessage: function (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 is the unique constraint violation error code
      if (error.code === "P2002") {
        const target = error.meta?.target;
        return `A user with that ${target?.join(", ")} already exists`;
      }
    }
    return error.message;
  },

  create: async function ({
    username,
    password,
    role = "default",
    dailyMessageLimit = null,
    bio = "",
  }) {
    const passwordCheck = this.checkPasswordComplexity(password);
    if (!passwordCheck.checkedOK) {
      return { user: null, error: passwordCheck.error };
    }

    try {
      // Validate username format (validation function handles all checks)
      const validatedUsername = this.validations.username(username);

      const bcrypt = require("bcryptjs");
      const hashedPassword = bcrypt.hashSync(password, 10);
      const user = await prisma.users.create({
        data: {
          username: validatedUsername,
          password: hashedPassword,
          role: this.validations.role(role),
          bio: this.validations.bio(bio),
          dailyMessageLimit:
            this.validations.dailyMessageLimit(dailyMessageLimit),
        },
      });
      // T-4a (#25): a user with no grant is denied by the engine. The migration
      // backfilled the users that existed then; this keeps every user made
      // afterwards in step with its legacy role.
      await syncLegacyRoleGrant(user);
      return { user: this.filterFields(user), error: null };
    } catch (error) {
      console.error("FAILED TO CREATE USER.", error.message);
      return { user: null, error: this._identifyErrorAndFormatMessage(error) };
    }
  },
  // Log the changes to a user object, but omit sensitive fields
  // that are not meant to be logged.
  loggedChanges: function (updates, prev = {}) {
    const changes = {};
    const sensitiveFields = ["password"];

    Object.keys(updates).forEach((key) => {
      if (!sensitiveFields.includes(key) && updates[key] !== prev[key]) {
        changes[key] = `${prev[key]} => ${updates[key]}`;
      }
    });

    return changes;
  },

  update: async function (userId, updates = {}) {
    try {
      if (!userId) throw new Error("No user id provided for update");
      const currentUser = await prisma.users.findUnique({
        where: { id: parseInt(userId) },
      });
      if (!currentUser) return { success: false, error: "User not found" };

      // We previously had more lenient username validation, but now with more strict validation
      // we dont want to break existing users by changing non-username fields.
      // If they are not explictly changing the username, do not attempt to validate it.
      if (updates.hasOwnProperty("username")) {
        if (updates.username === currentUser.username) delete updates.username;
      }

      // Removes non-writable fields for generic updates
      // and force-casts to the proper type;
      Object.entries(updates).forEach(([key, value]) => {
        if (this.writable.includes(key)) {
          if (this.validations.hasOwnProperty(key)) {
            updates[key] = this.validations[key](
              this.castColumnValue(key, value)
            );
          } else {
            updates[key] = this.castColumnValue(key, value);
          }
          return;
        }
        delete updates[key];
      });

      // A refused `suspended` must never reach prisma as `undefined`: prisma
      // SKIPS an undefined field and returns success with nothing changed, which
      // reads to the caller as a suspend that worked.
      if (updates.hasOwnProperty("suspended") && updates.suspended === null)
        return {
          success: false,
          error:
            'suspended must be one of 1, "1", true, "true", 0, "0", false, "false"',
        };

      if (Object.keys(updates).length === 0)
        return { success: false, error: "No valid updates applied." };

      // Handle password specific updates
      if (updates.hasOwnProperty("password")) {
        const passwordCheck = this.checkPasswordComplexity(updates.password);
        if (!passwordCheck.checkedOK) {
          return { success: false, error: passwordCheck.error };
        }
        const bcrypt = require("bcryptjs");
        updates.password = bcrypt.hashSync(updates.password, 10);
      }

      // S12 (#136): suspension is offboarding, and offboarding must take the
      // user's credentials with it IN THE SAME TRANSACTION.
      //
      // Measured on `941aa79e8` before this existed: a suspended user's API key
      // still authenticated — `validApiKey` called `next()` with no status.
      //
      // This sweep is NOT what enforces that. Enforcement is at the READER:
      // `keyGrantPrincipal` refuses a suspended creator, the same way the
      // session and job branches already did. QA-2 showed why the distinction
      // matters — a sweep only covers the keys that exist when it runs, and
      // three paths walked past this one. What the sweep provides is the AUDIT
      // RECORD: `revokedAt` says when a key stopped working, which a resolver
      // check cannot express.
      //
      // In one transaction rather than a follow-up write: a crash between the
      // two leaves an account that is suspended in the UI and still usable by
      // its key, which is the worst of the two states and the one nobody would
      // think to check.
      // LEVEL-triggered, not edge-triggered. It used to require a TRANSITION
      // (`currentUser.suspended !== 1`), so re-suspending an already-suspended
      // user swept nothing while reporting success — and a key minted between
      // the two calls survived. The `revokedAt: null` filter already makes the
      // sweep idempotent, so running it every time costs a no-op update.
      //
      // The sweep is kept even though `keyGrantPrincipal` now refuses a
      // suspended creator: `revokedAt` is the audit record of when a key stopped
      // working, and the resolver check leaves no such record.
      const isSuspending = updates.suspended === 1;

      let revokedKeyCount = 0;
      const user = await prisma.$transaction(async (tx) => {
        const updated = await tx.users.update({
          where: { id: parseInt(userId) },
          data: updates,
        });
        if (isSuspending)
          revokedKeyCount = await revokeCredentialsFor(updated.id, tx);
        return updated;
      });

      // A role change must move the grant with it — a demoted admin who keeps
      // super_admin is the failure that matters here (T-4a).
      if (updates.hasOwnProperty("role") && updates.role !== currentUser.role)
        await syncLegacyRoleGrant(user, { previousRole: currentUser.role });

      await emitAuditEvent(
        "user_updated",
        {
          username: user.username,
          changes: this.loggedChanges(updates, currentUser),
          // How many credentials the offboarding actually destroyed. Zero is
          // meaningful too — it says the sweep ran and found nothing, which is a
          // different fact from the sweep not running.
          ...(isSuspending ? { revokedKeyCount } : {}),
        },
        userId
      );
      return { success: true, error: null };
    } catch (error) {
      console.error("FAILED TO UPDATE USER.", error.message);
      return {
        success: false,
        error: this._identifyErrorAndFormatMessage(error),
      };
    }
  },

  /**
   * Explicit direct update of user object.
   * Only use this method when directly setting a key value
   * that takes no user input for the keys being modified.
   * @param {number} id - The id of the user to update.
   * @param {Object} data - The data to update the user with.
   * @returns {Promise<Object>} The updated user object.
   */
  _update: async function (id = null, data = {}) {
    if (!id) throw new Error("No user id provided for update");

    try {
      const user = await prisma.users.update({
        where: { id },
        data,
      });
      if (data?.role) await syncLegacyRoleGrant(user);
      return { user, message: null };
    } catch (error) {
      console.error(error.message);
      return { user: null, message: error.message };
    }
  },

  /**
   * Get all users that match the given clause without filtering the fields.
   * Internal use only - do not use this method for user-input flows
   * @param {Object} clause - The clause to filter the users by.
   * @param {number|null} limit - The maximum number of users to return.
   * @returns {Promise<Array<User>>} The users that match the given clause.
   */
  _where: async function (clause = {}, limit = null) {
    try {
      const users = await prisma.users.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return users;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * Returns a user object based on the clause provided.
   * @param {Object} clause - The clause to use to find the user.
   * @returns {Promise<import("@prisma/client").users|null>} The user object or null if not found.
   */
  get: async function (clause = {}) {
    try {
      const user = await prisma.users.findFirst({ where: clause });
      return user ? this.filterFields({ ...user }) : null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },
  // Returns user object with all fields
  _get: async function (clause = {}) {
    try {
      const user = await prisma.users.findFirst({ where: clause });
      return user ? { ...user } : null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.users.count({ where: clause });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  delete: async function (clause = {}) {
    try {
      // S12 (#136, TL-2): stamp `revokedAt` before the rows lose their owner.
      // The reader already refuses a key whose creator is gone, so this is not
      // what closes the hole — it is the investigator's record of WHEN the key
      // stopped working, which a resolver check cannot express and which no
      // later query can reconstruct once the user row is gone.
      //
      // The key rows are NOT deleted. `browser_extension_api_keys` disappears
      // only because its foreign key cascades; `api_keys` has none, and keeping
      // the stamped row is the point.
      await prisma.$transaction(async (tx) => {
        const doomed = await tx.users.findMany({
          where: clause,
          select: { id: true },
        });
        for (const { id } of doomed) await revokeCredentialsFor(id, tx);
        await tx.users.deleteMany({ where: clause });
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (clause = {}, limit = null) {
    try {
      const users = await prisma.users.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return users.map((usr) => this.filterFields(usr));
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * S11a (#80): the caller-fixable half of `create`, without touching the
   * database.
   *
   * Split out for the invite redemption route, which must answer "your username
   * is malformed" before it looks at the invite code — otherwise the mere fact
   * that a specific answer came back tells the caller their code was real.
   *
   * PURE by requirement, not by accident: it runs before any lookup, so it must
   * not read a row, and it must never report whether a username is TAKEN. That
   * is a fact about the database and belongs behind the flat refusal.
   *
   * @returns {string|null} the message to show, or null when the input is fine.
   */
  validateNewCredentials: function ({ username, password } = {}) {
    const passwordCheck = this.checkPasswordComplexity(password);
    if (!passwordCheck.checkedOK) return passwordCheck.error;
    try {
      this.validations.username(username);
    } catch (error) {
      return error.message;
    }
    return null;
  },

  checkPasswordComplexity: function (passwordInput = "") {
    const passwordComplexity = require("joi-password-complexity");
    // Can be set via ENV variable on boot. No frontend config at this time.
    // Docs: https://www.npmjs.com/package/joi-password-complexity
    const complexityOptions = {
      min: process.env.PASSWORDMINCHAR || 8,
      max: process.env.PASSWORDMAXCHAR || 250,
      lowerCase: process.env.PASSWORDLOWERCASE || 0,
      upperCase: process.env.PASSWORDUPPERCASE || 0,
      numeric: process.env.PASSWORDNUMERIC || 0,
      symbol: process.env.PASSWORDSYMBOL || 0,
      // reqCount should be equal to how many conditions you are testing for (1-4)
      requirementCount: process.env.PASSWORDREQUIREMENTS || 0,
    };

    const complexityCheck = passwordComplexity(
      complexityOptions,
      "password"
    ).validate(passwordInput);
    if (complexityCheck.hasOwnProperty("error")) {
      let myError = "";
      let prepend = "";
      for (let i = 0; i < complexityCheck.error.details.length; i++) {
        myError += prepend + complexityCheck.error.details[i].message;
        prepend = ", ";
      }
      return { checkedOK: false, error: myError };
    }

    return { checkedOK: true, error: "No error." };
  },

  /**
   * Check if a user can send a chat based on their daily message limit.
   * This limit is system wide and not per workspace and only applies to
   * multi-user mode AND non-admin users.
   * @param {User} user The user object record.
   * @returns {Promise<boolean>} True if the user can send a chat, false otherwise.
   */
  canSendChat: async function (user, { exemptFromLimit = false } = {}) {
    // T-4a (#25): the admin exemption was a role string read in the model. The
    // quota itself is not an authorization decision, so the exemption is passed
    // in by the caller that knows the actor rather than re-derived here.
    if (!user || user.dailyMessageLimit === null || exemptFromLimit) return true;

    const { WorkspaceChats } = require("./workspaceChats");
    const currentChatCount = await WorkspaceChats.count({
      user_id: user.id,
      createdAt: {
        gte: new Date(new Date() - 24 * 60 * 60 * 1000), // 24 hours
      },
    });

    return currentChatCount < user.dailyMessageLimit;
  },
};

module.exports = { User };
