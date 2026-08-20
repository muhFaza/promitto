/**
 * Non-interactive check for `compareVersions`. No database, no environment —
 * the function is pure, so this is a plain import. Usage:
 *   tsx scripts/test-version-compare.ts
 *
 * This exists because the failure is silent in the direction that matters. If
 * the comparison is wrong, Settings tells every user "up to date" while the
 * server sits on an old release, and nothing anywhere logs that it lied. The
 * unparseable cases matter for the same reason: a tag nobody anticipated must
 * fall back to "no update" rather than being guessed at.
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';

import { compareVersions } from '../src/lib/version.js';

let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

// --- ordering ---------------------------------------------------------------
assert.ok(compareVersions('1.0.1', '1.0.0') > 0, 'patch ahead');
assert.ok(compareVersions('1.1.0', '1.0.9') > 0, 'minor beats a higher patch');
assert.ok(compareVersions('2.0.0', '1.99.99') > 0, 'major beats everything below it');
pass('(1) a newer version compares greater');

assert.ok(compareVersions('1.0.0', '1.0.1') < 0, 'patch behind');
assert.ok(compareVersions('1.0.0', '2.0.0') < 0, 'major behind');
pass('(2) an older version compares lesser');

assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
pass('(3) equal versions compare equal');

// --- the `v` prefix ---------------------------------------------------------
// GitHub tags are `v1.0.0`; package.json is `1.0.0`. These must compare equal
// or every instance reports an update against itself, forever.
assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
assert.ok(compareVersions('v1.0.1', '1.0.0') > 0);
assert.equal(compareVersions('V1.0.0', '1.0.0'), 0);
pass('(4) a leading v (either case) is ignored');

// --- unequal segment counts -------------------------------------------------
assert.equal(compareVersions('1.0', '1.0.0'), 0, 'missing segments are zero');
assert.ok(compareVersions('1.0.1', '1.0') > 0);
assert.ok(compareVersions('1.2.3.4', '1.2.3') > 0, 'a fourth segment still ranks');
pass('(5) missing trailing segments count as zero');

// --- numeric, not lexicographic ---------------------------------------------
// The bug this catches: '10' < '9' as strings, so a string sort would tell
// every user on v0.10.0 that v0.9.0 is newer.
assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
assert.ok(compareVersions('10.0.0', '9.0.0') > 0);
pass('(6) segments compare numerically, not as strings');

// --- pre-release / build suffixes -------------------------------------------
// Only the release core is ranked. Full semver precedence is deliberately not
// implemented: this project does not publish pre-releases, and a half-right
// implementation would be worse than an explicit "same".
assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), 0);
assert.equal(compareVersions('1.0.0+build5', '1.0.0'), 0);
assert.ok(compareVersions('1.0.1-rc1', '1.0.0') > 0);
pass('(7) a pre-release or build suffix is stripped, not ranked');

// --- garbage falls back to "no update" --------------------------------------
// 0 is the safe answer: `updateAvailable` is `latest > current`, so anything
// unparseable reads as "no update available" rather than nagging forever.
for (const bad of ['', 'latest', 'v', 'nightly', '1.x', 'abc.def', '..', '1..0', ' ']) {
  assert.equal(compareVersions(bad, '1.0.0'), 0, `unparseable latest: ${JSON.stringify(bad)}`);
  assert.equal(compareVersions('1.0.0', bad), 0, `unparseable current: ${JSON.stringify(bad)}`);
}
pass('(8) an unparseable version on either side compares equal');

// --- surrounding whitespace -------------------------------------------------
assert.equal(compareVersions('  v1.0.0  ', '1.0.0'), 0);
pass('(9) surrounding whitespace is tolerated');

console.log(`\nOK ${passed}/${passed} assertions passed`);
