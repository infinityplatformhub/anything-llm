const prisma = require("../prisma");
const { redactEventData } = require("./redaction");

class AuditEventSubscriber {
  constructor({ db = prisma } = {}) {
    this.db = db;
  }

  async handle(event) {
    const userId = event.actor.type === "user" && event.actor.id ? Number(event.actor.id) : null;
    // T-6 (#28): redact at the sink, before the row exists. Every write path to
    // event_logs goes through here, so a new emitAuditEvent call site is covered
    // the day it is written rather than the day someone remembers to guard it.
    const { data } = redactEventData(event.data);
    await this.db.event_logs.upsert({
      where: { eventId: event.eventId },
      create: {
        eventId: event.eventId,
        event: event.type,
        metadata: data == null ? null : JSON.stringify(data),
        userId,
        occurredAt: event.occurredAt,
      },
      update: {},
    });
  }
}

/**
 * The ONLY sanctioned delete path for event_logs (enforced by
 * __tests__/utils/coreServices/eventBoundary.test.js). Returns the number of rows
 * removed, which the T-6 retention purge needs to batch and to report what it did.
 */
async function deleteAuditEvents(clause, db = prisma) {
  const { count } = await db.event_logs.deleteMany({ where: clause });
  return count;
}

module.exports = { AuditEventSubscriber, deleteAuditEvents };
