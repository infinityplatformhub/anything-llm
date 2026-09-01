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

async function deleteAuditEvents(clause, db = prisma) {
  await db.event_logs.deleteMany({ where: clause });
}

module.exports = { AuditEventSubscriber, deleteAuditEvents };
