import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Nexus } from '../dist/index.js';

import { __shieldSha256Head as sha256Head, __shieldSolvePow as solvePow } from '../dist/index.js';

const bits = (buf) => {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
};

test('proof-of-work helper agrees with the backend formula', async () => {
  const binding = createHash('sha256').update('nexus-shield/v1\nC\nK').digest();
  for (const len of [0, 1, 55, 56, 63, 64, 100]) {
    const m = Buffer.alloc(len, 7);
    assert.equal(sha256Head(new Uint8Array(m)), createHash('sha256').update(m).digest().readUInt32BE(0));
  }
  const nonce = await solvePow(new Uint8Array(binding), 12);
  assert.ok(bits(createHash('sha256').update(binding).update(nonce).digest()) >= 12);
});

test('server verify: short-circuits a missing token and posts the rest', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ valid: true, decision: 'allow', mode: 'enforce', reason: null, resource: 'checkout', policy: 'checkout', token: null }), { status: 200 });
  };
  const n = Nexus.init({ apiKey: 'nxs_x_y', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent', fetch }, { force: true });
  const missing = await n.shield.verify({ token: undefined, method: 'POST', url: 'https://a/b' });
  assert.equal(missing.reason, 'token_missing');
  assert.equal(calls.length, 0);
  const v = await n.shield.verify({ token: ['t1'], proof: 'p1', method: 'POST', url: 'https://api/checkout', resource: 'checkout' });
  assert.equal(v.decision, 'allow');
  assert.match(calls[0].url, /\/partner\/shield\/verify$/);
  assert.deepEqual(calls[0].body, { token: 't1', proof: 'p1', method: 'POST', url: 'https://api/checkout', resource: 'checkout' });
  n.dispose();
});
