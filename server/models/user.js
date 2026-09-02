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
 * Revoke every bearer credential belonging to a user being offboarded.
 *
 * `revokedAt` is what `ApiKey.validate` consults (`models/apiKeys.js:91`), so
 * setting it is what actually stops the key rather than merely recording that it
 * should have stopped.
 *
 * Already-revoked keys are left alone: `revokedAt: null` in the filter keeps the
 * ORIGINAL revocation timestamp, which is audit history. Re-stamping it would
 * rewrite when a key stopped working.
 *
 * Browser-extension keys need no equivalent: `validBrowserExtensionApiKey.js:27`
 * re-reads `suspended` on every request, and its key table has a real foreign key
 * to `users`.
 */
async function revokeCredentialsFor(userId, tx) {
  await tx.api_keys.updateMany({
    where: { createdBy: Number(userId), revokedAt: null },
    data: { revokedAt: new Date() },
  });
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
      case "suspended":
        return Number(Boolean(value));
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
      // still authenticated — `validApiKey` called `next()` with no status. The
      // session path was closed (`validatedRequest` re-reads `suspended`), so
      // the key was the way back in.
      //
      // In one transaction rather than a follow-up write: a crash between the
      // two leaves an account that is suspended in the UI and still usable by
      // its key, which is the worst of the two states and the one nobody would
      // think to check.
      const isSuspending =
        updates.suspended === 1 && currentUser.suspended !== 1;

      const user = await prisma.$transaction(async (tx) => {
        const updated = await tx.users.update({
          where: { id: parseInt(userId) },
          data: updates,
        });
        if (isSuspending) await revokeCredentialsFor(updated.id, tx);
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
      await prisma.users.deleteMany({ where: clause });
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
