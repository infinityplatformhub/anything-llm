const crypto = require("crypto");
const { PostgresEventBus } = require("./PostgresEventBus");
const { AuditEventSubscriber } = require("./AuditEventSubscriber");

const eventBus = new PostgresEventBus();
let auditRegistered;

async function ensureAuditSubscriber() {
  if (!auditRegistered) {
    const audit = new AuditEventSubscriber();
    auditRegistered = eventBus.subscribe({ subscriberId: "audit", eventTypes: ["*"], handler: audit.handle.bind(audit) });
  }
  await auditRegistered;
}

async function emitAuditEvent(type, data = {}, userId = null, options = {}) {
  await ensureAuditSubscriber();
  const event = {
    eventId: options.eventId || crypto.randomUUID(),
    type,
    version: 1,
    occurredAt: options.occurredAt || new Date(),
    actor: options.actor || { type: userId ? "user" : "system", id: userId ? String(userId) : null, orgId: options.orgId || "default" },
    resource: options.resource || { type: "system", id: null },
    traceId: options.traceId || crypto.randomUUID(),
    data,
    sensitivity: options.sensitivity || "metadata",
  };
  await eventBus.publish({ event, transaction: options.transaction });
  if (!options.transaction) await eventBus.deliver();
  return { event, message: null };
}

module.exports = { eventBus, emitAuditEvent, ensureAuditSubscriber };
