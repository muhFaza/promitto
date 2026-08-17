/**
 * Non-interactive check for `anonymizeIp`. No database, no environment — the
 * function is pure, so this is a plain import. Usage:
 *   tsx scripts/test-ip-anonymize.ts
 *
 * The point of most of these cases is the *rejections*. A `null` is always safe
 * to store; a prefix invented from malformed input ("999.2.3.4" → "999.2.3.0/24")
 * is a claim about a network that does not exist, and it would sit in
 * `sessions.ip` looking exactly like a real one.
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';

import { anonymizeIp } from '../src/lib/ip.js';

let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`PASS ${label}`);
}

/** Each case: input, expected output, and why it matters. */
const cases: Array<[string, string | null | undefined, string | null]> = [
  // ---- accepted ---------------------------------------------------------
  ['plain IPv4 keeps three octets', '203.0.113.42', '203.0.113.0/24'],
  ['IPv4 boundary octets 0 and 255', '255.0.113.255', '255.0.113.0/24'],
  ['IPv4-mapped IPv6, lower case (what Express reports)', '::ffff:192.0.2.1', '192.0.2.0/24'],
  ['IPv4-mapped IPv6, upper case', '::FFFF:192.0.2.1', '192.0.2.0/24'],
  ['loopback ::1 expands to eight groups', '::1', '0:0:0::/48'],
  ['zone identifier is stripped, not parsed', 'fe80::1%eth0', 'fe80:0:0::/48'],
  ['full eight-group IPv6', '2001:db8:1234:5678:9abc:def0:1234:5678', '2001:db8:1234::/48'],
  ['compressed IPv6 in the middle', '2001:db8::1', '2001:db8:0::/48'],
  ['bracketed IPv6 with a port', '[::1]:443', '0:0:0::/48'],
  ['IPv4 with a port suffix', '1.2.3.4:5678', '1.2.3.0/24'],
  ['surrounding whitespace is trimmed', '  203.0.113.42  ', '203.0.113.0/24'],

  // ---- rejected ---------------------------------------------------------
  ['out-of-range octet is not a network', '999.2.3.4', null],
  ['hex octet is not a network (Number() would accept it)', '0x10.2.3.4', null],
  ['space inside an octet is not a network', '1 .2.3.4', null],
  ['empty octet', '1..3.4', null],
  ['leading + is not a digit', '+1.2.3.4', null],
  ['negative octet', '1.-2.3.4', null],
  ['exponent notation', '1e2.2.3.4', null],
  ['three octets is not an address', '1.2.3', null],
  ['five octets is not an address', '1.2.3.4.5', null],
  ['empty string', '', null],
  ['whitespace only', '   ', null],
  ['null', null, null],
  ['undefined', undefined, null],
  ['two "::" elisions are ambiguous', '1::2::3', null],
  ['":::" is two overlapping elisions', 'fe80:::1', null],
  ['non-hex group', '2001:zzzz::1', null],
  ['group longer than four hex digits', '2001:db8abc::1', null],
  ['too many groups without an elision', '1:2:3:4:5:6:7:8:9', null],
  ['too few groups without an elision', '1:2:3:4:5:6:7', null],
  ['unclosed bracket', '[::1', null],
  ['bracketed form with trailing junk', '[::1]junk', null],
  ['not an address at all', 'unknown', null],
];

let failure: unknown = null;
try {
  for (const [label, input, expected] of cases) {
    assert.equal(
      anonymizeIp(input),
      expected,
      `${label}: anonymizeIp(${JSON.stringify(input)}) should be ${JSON.stringify(expected)} — got ${JSON.stringify(anonymizeIp(input))}`,
    );
    pass(label);
  }

  // The invariant behind every rejection above, stated once directly: whatever
  // comes back is either null or a prefix ending in a known mask. Nothing that
  // merely *looks* like an address is ever passed through unchanged.
  for (const [, input] of cases) {
    const out = anonymizeIp(input);
    assert.ok(
      out === null || out.endsWith('.0/24') || out.endsWith('::/48'),
      `anonymizeIp(${JSON.stringify(input)}) returned an unexpected shape: ${JSON.stringify(out)}`,
    );
  }
  pass('every result is null or a /24 or /48 prefix');
} catch (err) {
  failure = err;
}

const total = cases.length + 1;

if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  console.error(`FAIL after ${passed}/${total} assertions`);
  process.exit(1);
}

console.log(`OK ${passed}/${total} assertions passed`);
process.exit(0);
