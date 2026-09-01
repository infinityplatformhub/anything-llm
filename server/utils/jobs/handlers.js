const { Telemetry } = require("../../models/telemetry");

const handlers = {
  "telemetry.flush@1": async () => {
    await Telemetry.flush();
    return { flushed: true };
  },
  "retention.purge@1": async ({ traceId }) => {
    console.log(`[Retention purge scheduled] traceId=${traceId}`);
    return { purged: 0 };
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
