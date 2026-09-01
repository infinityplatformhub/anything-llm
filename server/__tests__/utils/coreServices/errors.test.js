// #14: seam error classes live in errors.js; drivers must re-export the SAME classes,
// so catch sites can import from either path without instanceof splitting.

const jobsErrors = require("../../../utils/jobs/errors");
const eventsErrors = require("../../../utils/events/errors");
const jobQueue = require("../../../utils/jobs/PostgresJobQueue");
const eventBus = require("../../../utils/events/PostgresEventBus");

describe("seam error class identity - issue 14", () => {
  test("PostgresJobQueue re-exports the exact classes from jobs/errors", () => {
    expect(jobQueue.LeaseLostError).toBe(jobsErrors.LeaseLostError);
    expect(jobQueue.ImpersonatedMutationError).toBe(jobsErrors.ImpersonatedMutationError);
  });

  test("PostgresEventBus re-exports the exact classes from events/errors", () => {
    expect(eventBus.EventConflictError).toBe(eventsErrors.EventConflictError);
    expect(eventBus.UnknownEventVersionError).toBe(eventsErrors.UnknownEventVersionError);
  });

  test("throwing them is instanceof from the canonical import path", () => {
    expect(() => { throw new jobsErrors.LeaseLostError("lease lost"); }).toThrow(jobsErrors.LeaseLostError);
    expect(() => { throw new eventsErrors.EventConflictError("conflict"); }).toThrow(eventsErrors.EventConflictError);
  });
});
