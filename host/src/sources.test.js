'use strict';

const assert = require('assert');
const { parseLines, describeError, SOURCES, createIPv4FirstLookup } = require('./sources');

assert.deepStrictEqual(parseLines([
  '127.0.0.1:8080',
  'http://192.0.2.10:3128',
  'socks5://203.0.113.5:1080',
  '256.1.1.1:80',
  '192.0.2.1:0',
  '192.0.2.1:65536',
  'not-an-ip:80',
].join('\n')), [
  '127.0.0.1:8080',
  '192.0.2.10:3128',
  '203.0.113.5:1080',
]);

assert.strictEqual(SOURCES.http[0].urls.length, 2);
assert.strictEqual(SOURCES.socks5[2].urls.length, 2);
assert.match(describeError(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' })), /DNS/);
assert.match(describeError(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })), /超时/);

// Prefer IPv4 while preserving the OS-provided DNS result set.
const fakeLookup = (_host, _options, cb) => cb(null, [
  { address: '2001:db8::1', family: 6 },
  { address: '192.0.2.10', family: 4 },
]);
const ipv4First = createIPv4FirstLookup(fakeLookup);
ipv4First('raw.githubusercontent.com', {}, (err, address, family) => {
  assert.ifError(err);
  assert.strictEqual(address, '192.0.2.10');
  assert.strictEqual(family, 4);
});

process.stdout.write('sources tests passed\\n');
