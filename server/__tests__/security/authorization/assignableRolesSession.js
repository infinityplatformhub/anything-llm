/**
 * The session the mocked `validatedRequest` reads, in its own module so the jest factory
 * can require it — a factory closing over a test-file variable is hoisted above the
 * variable's initialisation and reads undefined.
 */
let current = { id: null, impersonatedBy: null, apiKey: null };
module.exports = {
  current: () => current,
  set: (next) => {
    current = next;
  },
};
