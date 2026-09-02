const { User } = require("../../models/user");
const { EncryptionManager } = require("../EncryptionManager");
const { decodeJWT } = require("../http");
const { UserMetaCache } = require("../userLocale");
const {
  isConfirmedSingleUser,
} = require("../authorization/actorResolver");
const EncryptionMgr = new EncryptionManager();

async function validatedRequest(request, response, next) {
  // #46: this used to read SystemSettings.isMultiUserMode() directly. That call catches
  // its own errors and returns `false` (systemSettings.js:747), so an unreachable database
  // — or a missing multi_user_mode row after a partial restore — landed in the single-user
  // branch below, which calls next() with no check at all when NODE_ENV=development or
  // AUTH_TOKEN/JWT_SECRET are unset. That is the default shape of a dev box.
  //
  // Same swallowed error as T-4b's FINDING-1, different door: that one handed an anonymous
  // caller the super_admin service principal, this one skips session auth entirely.
  // Single-user is now CONFIRMED (setting agrees AND there are no user rows) using the
  // same helper the actor resolver uses, so the two halves of a request cannot disagree
  // about which mode they are in.
  const multiUserMode = !(await isConfirmedSingleUser());
  response.locals.multiUserMode = multiUserMode;
  if (multiUserMode)
    return await validateMultiUserRequest(request, response, next);

  // When in development passthrough auth token for ease of development.
  // Or if the user simply did not set an Auth token or JWT Secret
  if (
    process.env.NODE_ENV === "development" ||
    !process.env.AUTH_TOKEN ||
    !process.env.JWT_SECRET
  ) {
    UserMetaCache.setFromRequest(request);
    next();
    return;
  }

  if (!process.env.AUTH_TOKEN) {
    response.status(401).json({
      error: "You need to set an AUTH_TOKEN environment variable.",
    });
    return;
  }

  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const bcrypt = require("bcryptjs");
  const { p } = decodeJWT(token);

  if (p === null || !/\w{32}:\w{32}/.test(p)) {
    response.status(401).json({
      error: "Token expired or failed validation.",
    });
    return;
  }

  // Since the blame of this comment we have been encrypting the `p` property of JWTs with the persistent
  // encryptionManager PEM's. This prevents us from storing the `p` unencrypted in the JWT itself, which could
  // be unsafe. As a consequence, existing JWTs with invalid `p` values that do not match the regex
  // in ln:44 will be marked invalid so they can be logged out and forced to log back in and obtain an encrypted token.
  // This kind of methodology only applies to single-user password mode.
  if (
    !bcrypt.compareSync(
      EncryptionMgr.decrypt(p),
      bcrypt.hashSync(process.env.AUTH_TOKEN, 10)
    )
  ) {
    response.status(401).json({
      error: "Invalid auth credentials.",
    });
    return;
  }

  UserMetaCache.setFromRequest(request);
  next();
}

async function validateMultiUserRequest(request, response, next) {
  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const valid = decodeJWT(token);
  if (!valid || !valid.id) {
    response.status(401).json({
      error: "Invalid auth token.",
    });
    return;
  }

  const user = await User.get({ id: valid.id });
  if (!user) {
    response.status(401).json({
      error: "Invalid auth for user.",
    });
    return;
  }

  if (user.suspended) {
    response.status(401).json({
      error: "User is suspended from system",
    });
    return;
  }

  response.locals.user = user;
  // T-7 (#31, D-3): carry impersonation provenance from the token into locals,
  // where actorResolver reads it. The claim is signed, so it cannot be added or
  // removed by the holder — dropping it is what would turn a read-only
  // view-as-user session into a real one.
  if (valid.impersonatedBy) response.locals.impersonatedBy = valid.impersonatedBy;
  UserMetaCache.setFromRequest(request, user.id);
  next();
}

module.exports = {
  validatedRequest,
};
