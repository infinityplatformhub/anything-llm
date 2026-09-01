const crypto = require("crypto");
const prisma = require("../prisma");

class EventConflictError extends Error {}
class UnknownEventVersionError extends Error {}
const canonical = (event) => crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");

class PostgresEventBus {
  constructor({ db = prisma, now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
    this.workerId = `events-${process.pid}-${crypto.randomUUID()}`;
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
    try {
      await db.event_outbox.create({
        data: {
          id: event.eventId, type: event.type, version: event.version, occurredAt: event.occurredAt,
          actor: JSON.stringify(event.actor), resource: JSON.stringify(event.resource), traceId: event.traceId,
          data: JSON.stringify(event.data), sensitivity: event.sensitivity, payloadHash: hash,
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const raced = await db.event_outbox.findUnique({ where: { id: event.eventId } });
      if (!raced || raced.payloadHash !== hash) throw new EventConflictError(`Event ${event.eventId} payload mismatch`);
    }
  }

  async subscribe({ subscriberId, eventTypes, handler, maxAttempts = 3, versions = [1] }) {
    this.subscribers.set(subscriberId, { eventTypes: new Set(eventTypes), handler, maxAttempts, versions: new Set(versions) });
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
    const now = this.now();
    const due = await this.db.event_outbox.findMany({
      where: {
        OR: [
          { deliveries: { none: {} } },
          { deliveries: { some: { state: "retrying", nextAttemptAt: { lte: now }, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] } } },
        ],
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    for (const row of due) {
      for (const [subscriberId, subscriber] of this.subscribers) {
        if (!subscriber.eventTypes.has(row.type) && !subscriber.eventTypes.has("*")) continue;
        const delivery = await this.db.event_deliveries.findUnique({ where: { subscriberId_eventId: { subscriberId, eventId: row.id } } });
        if (delivery?.state === "acknowledged" || delivery?.state === "dead-lettered" || delivery?.state === "quarantined") continue;
        if (!subscriber.versions.has(row.version)) {
          await this.recordFailure({ subscriberId, row, subscriber, delivery, error: new UnknownEventVersionError(`Unknown event version ${row.version}`), state: "quarantined" });
          continue;
        }
        const event = this.toEvent(row);
        try {
          await subscriber.handler(event);
          await this.acknowledge({ subscriberId, eventId: row.id });
        } catch (error) {
          await this.recordFailure({ subscriberId, row, subscriber, delivery, error });
        }
      }
    }
  }

  toEvent(row) {
    return { eventId: row.id, type: row.type, version: row.version, occurredAt: row.occurredAt, actor: JSON.parse(row.actor), resource: JSON.parse(row.resource), traceId: row.traceId, data: JSON.parse(row.data), sensitivity: row.sensitivity };
  }

  async recordFailure({ subscriberId, row, subscriber, delivery, error, state }) {
    const attempts = (delivery?.attempts || 0) + 1;
    const finalState = state || (attempts >= subscriber.maxAttempts ? "dead-lettered" : "retrying");
    await this.db.event_deliveries.upsert({
      where: { subscriberId_eventId: { subscriberId, eventId: row.id } },
      create: { subscriberId, eventId: row.id, attempts, state: finalState, lastError: error.message, nextAttemptAt: finalState === "retrying" ? new Date(this.now().getTime() + 1000 * 2 ** attempts) : null },
      update: { attempts, state: finalState, lastError: error.message, nextAttemptAt: finalState === "retrying" ? new Date(this.now().getTime() + 1000 * 2 ** attempts) : null },
    });
    if ((finalState === "dead-lettered" || finalState === "quarantined") && row.type !== "event.delivery_failed") {
      const event = {
        eventId: crypto.randomUUID(), type: "event.delivery_failed", version: 1, occurredAt: new Date(),
        actor: { type: "system", id: null, orgId: JSON.parse(row.actor).orgId },
        resource: { type: "event", id: row.id }, traceId: row.traceId,
        data: { subscriberId, originalType: row.type, state: finalState, errorName: error.name }, sensitivity: "metadata",
      };
      await this.publish({ event });
    }
  }

  async replay({ subscriberId, from, to, eventTypes }) {
    const rows = await this.db.event_outbox.findMany({
      where: { occurredAt: { gte: from, ...(to ? { lte: to } : {}) }, ...(eventTypes?.length ? { type: { in: eventTypes } } : {}) },
      select: { id: true },
    });
    for (const { id } of rows) await this.db.event_deliveries.deleteMany({ where: { subscriberId, eventId: id } });
    return { queued: rows.length };
  }
}

module.exports = { PostgresEventBus, EventConflictError, UnknownEventVersionError };
