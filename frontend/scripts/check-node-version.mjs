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

export const REQUIRED_MAJOR = 22;

/**
 * @returns {string|null} the complaint, or null when the running Node is right.
 *
 * Returns rather than exits, because this runs from two places with different
 * powers: `pretest`, which may exit the process, and vitest's `setupFiles`, where
 * `process.exit` inside a worker is not how a run should end.
 */
export function nodeVersionComplaint() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major === REQUIRED_MAJOR) return null;
  return (
    `\n  Node ${process.versions.node} cannot run this test suite — Node ${REQUIRED_MAJOR}.x is required.\n\n` +
      `  On other majors jsdom leaves window.localStorage undefined, and every test that\n` +
      `  touches it fails with "Cannot read properties of undefined (reading 'clear')" —\n` +
      `  an error that points at the tests rather than at the Node version causing it.\n\n` +
    `  Switch with:  nvm use ${REQUIRED_MAJOR}\n` +
    `  CI pins Node ${REQUIRED_MAJOR} (.github/workflows/ci.yml), as does "engines" in package.json.\n\n`
  );
}

// #139 (TL-2 pre-read): the guard above is only as good as the number it compares
// against, and that number is written down in eight places — four `.nvmrc` files and
// four `engines` ranges. They HAD drifted: frontend, server and collector all said
// v18.18.0 while every `engines` said >=22 <23, so `nvm use` in three of the four
// packages selected a Node three majors below the one the code requires.
//
// Checked here rather than in a test file because this script is what runs before the
// suite: a drift check that only runs when someone remembers to run it is the same
// shape as the version guard it accompanies.
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** @returns {string|null} the complaint, or null when all four agree. */
export function nvmrcDriftComplaint() {
  const drift = [];

  for (const pkg of [".", "frontend", "server", "collector"]) {
    const nvmrcPath = join(REPO, pkg, ".nvmrc");
    const pkgPath = join(REPO, pkg, "package.json");
    if (!existsSync(nvmrcPath) || !existsSync(pkgPath)) continue;

    // `.nvmrc` may be "22", "22.1.0" or "v18.18.0" — the major is what matters.
    const nvmrcMajor = Number(
      readFileSync(nvmrcPath, "utf8").trim().replace(/^v/, "").split(".")[0]
    );
    const range = JSON.parse(readFileSync(pkgPath, "utf8")).engines?.node;
    if (!range) continue;
    const enginesMajor = Number(range.match(/(\d+)/)?.[1]);

    if (nvmrcMajor !== enginesMajor)
      drift.push(
        `    ${pkg}/.nvmrc says ${nvmrcMajor}, but its engines says "${range}"`
      );
  }

  if (drift.length === 0) return null;
  return (
    `\n  .nvmrc and package.json disagree about the Node version:\n\n` +
    drift.join("\n") +
    `\n\n  Both must name the same major, or \`nvm use\` selects a runtime the\n` +
    `  code refuses to run on.\n\n`
  );
}

// CLI entry — this is what `pretest` runs. It stays because it fails FAST and once,
// before vitest starts up: the setup-file check below fires per worker, which is the
// right place for correctness but a noisy way to learn you are on the wrong Node.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const complaint = nodeVersionComplaint() ?? nvmrcDriftComplaint();
  if (complaint) {
    process.stderr.write(complaint);
    process.exit(1);
  }
}
