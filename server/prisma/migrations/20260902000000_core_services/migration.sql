ALTER TABLE "event_logs" ADD COLUMN "eventId" TEXT;
CREATE UNIQUE INDEX "event_logs_eventId_key" ON "event_logs"("eventId");

CREATE TABLE "jobs" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "idempotencyKey" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "workerId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "result" TEXT,
  "lastError" TEXT,
  "cancelReason" TEXT,
  "cancelledBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "jobs_type_idempotencyKey_key" ON "jobs"("type", "idempotencyKey");
CREATE INDEX "jobs_state_runAt_idx" ON "jobs"("state", "runAt");
CREATE INDEX "jobs_workerId_leaseUntil_idx" ON "jobs"("workerId", "leaseUntil");

CREATE TABLE "job_schedules" (
  "id" TEXT PRIMARY KEY, "type" TEXT NOT NULL, "cron" TEXT NOT NULL, "timezone" TEXT NOT NULL,
  "payload" TEXT NOT NULL, "actor" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "job_dead_letters" (
  "id" SERIAL PRIMARY KEY, "jobId" TEXT NOT NULL UNIQUE, "type" TEXT NOT NULL, "payload" TEXT NOT NULL,
  "actor" TEXT NOT NULL, "attempts" INTEGER NOT NULL, "error" TEXT NOT NULL, "traceId" TEXT NOT NULL,
  "deadLetteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "event_outbox" (
  "id" TEXT PRIMARY KEY, "type" TEXT NOT NULL, "version" INTEGER NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL,
  "actor" TEXT NOT NULL, "resource" TEXT NOT NULL, "traceId" TEXT NOT NULL, "data" TEXT NOT NULL,
  "sensitivity" TEXT NOT NULL, "payloadHash" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "event_outbox_occurredAt_idx" ON "event_outbox"("occurredAt");
CREATE INDEX "event_outbox_type_occurredAt_idx" ON "event_outbox"("type", "occurredAt");
CREATE TABLE "event_deliveries" (
  "id" SERIAL PRIMARY KEY, "subscriberId" TEXT NOT NULL, "eventId" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT, "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "event_deliveries_subscriberId_eventId_key" ON "event_deliveries"("subscriberId", "eventId");
CREATE INDEX "event_deliveries_state_idx" ON "event_deliveries"("state");
