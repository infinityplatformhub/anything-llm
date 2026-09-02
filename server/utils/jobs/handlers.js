const { Telemetry } = require("../../models/telemetry");
const { purge } = require("../retention/purge");

const handlers = {
  "telemetry.flush@1": async () => {
    await Telemetry.flush();
    return { flushed: true };
  },
  // T-6 Phase B (#28): the schedule already exists (retention-purge-daily,
  // 0 2 * * * UTC) — this fills the body it calls. The purge fails closed: an
  // unusable retention window returns skipped:true and deletes nothing.
  "retention.purge@1": async ({ traceId, db }) => {
    const result = await purge(db ? { db } : {});
    console.log(
      `[Retention purge] traceId=${traceId} purged=${result.purged} skipped=${result.skipped} retentionDays=${result.retentionDays} loginStates=${result.loginStatesPurged}`
    );
    return result;
  },
};

async function registerCoreSchedules(queue, actor) {
  await queue.schedule({
    scheduleId: "retention-purge-daily",
    type: "retention.purge",
    cron: "0 2 * * *",
    timezone: "UTC",
    payload: { version: 1 },
    actor,
    enabled: true,
  });
}

module.exports = { handlers, registerCoreSchedules };
