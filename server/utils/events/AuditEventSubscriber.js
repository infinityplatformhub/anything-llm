const prisma = require("../prisma");

class AuditEventSubscriber {
  constructor({ db = prisma } = {}) {
    this.db = db;
  }

  async handle(event) {
    const userId = event.actor.type === "user" && event.actor.id ? Number(event.actor.id) : null;
    await this.db.event_logs.upsert({
      where: { eventId: event.eventId },
      create: {
        eventId: event.eventId,
        event: event.type,
        metadata: JSON.stringify(event.data || {}),
        userId,
        occurredAt: event.occurredAt,
      },
      update: {},
    });
  }
}

module.exports = { AuditEventSubscriber };
