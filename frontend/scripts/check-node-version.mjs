#!/usr/bin/env node
// #139 — refuse to run the test suite on the wrong Node major.
//
// The failure this replaces: on Node 26, jsdom 25's `window.localStorage` is `undefined`
// while `"localStorage" in window` is still true. Every test whose setup calls
// `localStorage.clear()` then dies with
//
//   TypeError: Cannot read properties of undefined (reading 'clear')
//
// which names neither Node nor jsdom. Measured on this repo: `adminRoute.test.jsx` fails
// 9/9 and #121's `capabilityGating.test.jsx` 17/17, both of them merged and correct. A
// reader seeing that output reasonably concludes someone's component is broken, and the
// next hour goes into a file that was never at fault.
//
// `engines` already declares >=22 <23 and yarn enforces it, so a plain `yarn test` on
// Node 26 is refused before this runs. This guard exists for the two routes that get past
// that: `yarn --ignore-engines test`, and running vitest directly (`npx vitest`, an
// editor's test runner, a CI step that invokes the binary). Both were measured to reach
// the TypeErrors.

const REQUIRED_MAJOR = 22;
const major = Number(process.versions.node.split(".")[0]);

if (major !== REQUIRED_MAJOR) {
  process.stderr.write(
    `\n  Node ${process.versions.node} cannot run this test suite — Node ${REQUIRED_MAJOR}.x is required.\n\n` +
      `  On other majors jsdom leaves window.localStorage undefined, and every test that\n` +
      `  touches it fails with "Cannot read properties of undefined (reading 'clear')" —\n` +
      `  an error that points at the tests rather than at the Node version causing it.\n\n` +
      `  Switch with:  nvm use ${REQUIRED_MAJOR}\n` +
      `  CI pins Node ${REQUIRED_MAJOR} (.github/workflows/ci.yml), as does "engines" in package.json.\n\n`
  );
  process.exit(1);
}
