const crypto = require("crypto");
const prisma = require("../prisma");

class EventConflictError extends Error {}
const canonical = (event) => crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");

class PostgresEventBus {
  constructor({ db = prisma } = {}) {
    this.db = db;
    this.subscribers = new Map();
  }

  async publish({ event, transaction }) {
    const db = transaction || this.db;
    const hash = canonical(event);
    const existing = await db.event_outbox.findUnique({ where: { id: event.eventId } });
    if (existing) {
      if (existing.payloadHash !== hash) throw new EventConflictError(`Event ${event.eventId} payload mismatch`);
      return;
    }
    await db.event_outbox.create({
      data: {
        id: event.eventId,
        type: event.type,
        version: event.version,
        occurredAt: event.occurredAt,
        actor: JSON.stringify(event.actor),
        resource: JSON.stringify(event.resource),
        traceId: event.traceId,
        data: JSON.stringify(event.data),
        sensitivity: event.sensitivity,
        payloadHash: hash,
      },
    });
  }

  async subscribe({ subscriberId, eventTypes, handler, maxAttempts = 3 }) {
    this.subscribers.set(subscriberId, { eventTypes: new Set(eventTypes), handler, maxAttempts });
    return async () => this.subscribers.delete(subscriberId);
  }

  async acknowledge({ subscriberId, eventId }) {
    await this.db.event_deliveries.upsert({
      where: { subscriberId_eventId: { subscriberId, eventId } },
      create: { subscriberId, eventId, state: "acknowledged", acknowledgedAt: new Date() },
      update: { state: "acknowledged", acknowledgedAt: new Date() },
    });
  }

  async deliver(limit = 100) {
    const events = await this.db.event_outbox.findMany({ orderBy: { occurredAt: "asc" }, take: limit });
    for (const row of events) {
      for (const [subscriberId, subscriber] of this.subscribers) {
        if (!subscriber.eventTypes.has(row.type) && !subscriber.eventTypes.has("*")) continue;
        const delivery = await this.db.event_deliveries.findUnique({
          where: { subscriberId_eventId: { subscriberId, eventId: row.id } },
        });
        if (delivery?.state === "acknowledged" || delivery?.state === "dead-lettered") continue;
        const attempts = (delivery?.attempts || 0) + 1;
        const event = {
          eventId: row.id,
          type: row.type,
          version: row.version,
          occurredAt: row.occurredAt,
          actor: JSON.parse(row.actor),
          resource: JSON.parse(row.resource),
          traceId: row.traceId,
          data: JSON.parse(row.data),
          sensitivity: row.sensitivity,
        };
        try {
          await subscriber.handler(event);
          await this.acknowledge({ subscriberId, eventId: row.id });
        } catch (error) {
          await this.db.event_deliveries.upsert({
            where: { subscriberId_eventId: { subscriberId, eventId: row.id } },
            create: { subscriberId, eventId: row.id, attempts, state: attempts >= subscriber.maxAttempts ? "dead-lettered" : "retrying", lastError: error.message },
            update: { attempts, state: attempts >= subscriber.maxAttempts ? "dead-lettered" : "retrying", lastError: error.message },
          });
        }
      }
    }
  }

  async replay({ subscriberId, from, to, eventTypes }) {
    const rows = await this.db.event_outbox.findMany({
      where: {
        occurredAt: { gte: from, ...(to ? { lte: to } : {}) },
        ...(eventTypes?.length ? { type: { in: eventTypes } } : {}),
      },
      select: { id: true },
    });
    for (const { id } of rows) {
      await this.db.event_deliveries.deleteMany({ where: { subscriberId, eventId: id } });
    }
    return { queued: rows.length };
  }
}

module.exports = { PostgresEventBus, EventConflictError };
