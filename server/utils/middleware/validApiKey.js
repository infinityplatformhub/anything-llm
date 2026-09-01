const { ApiKey } = require("../../models/apiKeys");
const { SystemSettings } = require("../../models/systemSettings");
const { emitAuditEvent } = require("../events");
const prisma = require("../prisma");
const { resolveActor } = require("../authorization/actorResolver");
const { DatabaseAuthorizationEngine } = require("../authorization/engine");

// T-4b (#29) W-8: PR-4a gave this middleware the SCOPE half of `/v1` authorization — does
// the key's scope string permit the action. Nothing asked the other half: does the
// principal behind the key actually HOLD a grant for it. Effective permission is
// grants(createdBy) ∩ scopes(key), so a key whose creator was demoted, or one minted with
// a scope its creator never held, passed anyway.
//
// The check lives here rather than in a router-level middleware because Express runs
// router `use()` in registration order and every /v1 route registers after the mount: a
// separate middleware could only run BEFORE apiKeyContext exists, forcing a second key
// lookup and leaving grant denials outside the `auth.key_used` audit event.
const WILDCARD_ACTION = "*";

/**
 * The grant half. Returns true when the action is permitted for the principal behind the
 * key, false otherwise — including when nothing can be resolved or the policy store is
 * unavailable, because "nothing objected" is not the same as "something approved".
 */
async function grantAllows(action, request, response, engine) {
  // Wildcard routes carry no action to evaluate. They are Dev1's burn-down list
  // (EXPECTED_WILDCARD_ROUTES) and keep scope-only behaviour until it reaches zero.
  if (action === WILDCARD_ACTION) return true;
  try {
    const actor = await resolveActor(request, response);
    if (!actor) return false;
    const workspaceId = actor.keyWorkspaceBinding?.length
      ? Number(actor.keyWorkspaceBinding[0])
      : null;
    const decision = await engine.authorize({
      actor,
      action,
      // The route's own resource is resolved by the handler; at ingress the only thing
      // known is the key's workspace binding, which is what the engine gates on.
      resource: { type: "api_route", id: null, orgId: actor.orgId ?? 1, workspaceId },
    });
    return decision.allowed === true;
  } catch (error) {
    console.error(`[authorization] grant check failed for ${action}: ${error.message}`);
    return false;
  }
}


async function workspaceBindingMatches(context, request, binding, db = prisma) {
  if (!context?.workspaceId || !binding) return true;
  if (binding.workspaceParam)
    return context.workspaceId === String(request.params?.[binding.workspaceParam]);
  if (binding.workspaceSlugParam) {
    const workspace = await db.workspaces.findUnique({
      where: { slug: String(request.params?.[binding.workspaceSlugParam]) },
      select: { id: true },
    });
    return !!workspace && context.workspaceId === String(workspace.id);
  }
  return true;
}

function validApiKey(action, binding = null) {
  if (typeof action !== "string" || !action) throw new Error("validApiKey requires an explicit scope");
  const engine = new DatabaseAuthorizationEngine();
  const middleware = async function apiKeyRequired(request, response, next) {
    response.locals.multiUserMode = await SystemSettings.isMultiUserMode();
    const bearerKey = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const apiKey = bearerKey ? await ApiKey.resolve(bearerKey) : null;
    if (!apiKey) return response.status(403).json({ error: "No valid api key found." });
    const context = {
      keyId: String(apiKey.id), keyPrefix: apiKey.keyPrefix, scopes: apiKey.scopes,
      workspaceId: apiKey.workspaceId ? String(apiKey.workspaceId) : null,
      expiresAt: apiKey.expiresAt, revokedAt: apiKey.revokedAt,
    };
    response.locals.apiKeyContext = context;
    const scopeAllowed = context.scopes.includes("*") || context.scopes.includes(action);
    const workspaceAllowed = await workspaceBindingMatches(context, request, binding);
    const scopePassed = scopeAllowed && workspaceAllowed;
    // The scope half runs first, and a request that already failed it never reaches the
    // engine — it must not be able to make the policy store do work.
    const grantPassed = scopePassed
      ? await grantAllows(action, request, response, engine)
      : false;
    const allowed = scopePassed && grantPassed;
    // One event, not two: `auth.key_used` already carries `allowed`, so a grant denial is
    // recorded there with the half that rejected it. A separate event would leave the
    // original saying the key was used successfully while the caller saw a 403.
    const denyReason = allowed ? null : scopePassed ? "grant" : "scope";
    await prisma.$transaction(async (transaction) => {
      await transaction.api_keys.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
      await emitAuditEvent("auth.key_used", {
        scopedKeyId: context.keyId, keyPrefix: context.keyPrefix, action, allowed, denyReason, orgId: 1,
      }, null, { resource: { type: "api_key", id: context.keyId }, transaction });
    });
    // One message for both halves: which half rejected is audit detail, not something a
    // caller probing the API should be able to read off the response.
    if (!allowed) return response.status(403).json({ error: "Insufficient scope." });
    next();
  };
  middleware.isApiKeyGuard = true;
  middleware.scope = action;
  return middleware;
}

module.exports = { validApiKey, workspaceBindingMatches };
