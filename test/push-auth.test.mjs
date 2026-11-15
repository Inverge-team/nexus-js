import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { NexusPushAuth, PushAuthError, verifyWebhook } from '../dist/push-auth/index.js';

function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const r = responses.shift() ?? [200, {}];
    const [status, json] = r;
    return { ok: status < 300, status, async text() { return JSON.stringify(json); }, async json() { return json; } };
  };
  fn.calls = calls;
  return fn;
}
const client = (fetch) => new NexusPushAuth({ apiKey: 'nxs_test', baseUrl: 'https://api.test/', fetch });
const pending = (extra = {}) => ({ id: 'pac_1', status: 'pending', stage: null, method: 'number_match', requesterView: { number: '42' }, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra });

test('requires an API key', () => {
  assert.throws(() => new NexusPushAuth({}), /apiKey is required/);
});

test('createChallenge sends the API key and the body as given', async () => {
  const fetch = fakeFetch([201, pending()]);
  const c = await client(fetch).createChallenge({ identity: 'u1', method: 'number_match', details: { message: 'Sign in' } });
  assert.equal(c.requesterView.number, '42');
  const [call] = fetch.calls;
  assert.equal(call.url, 'https://api.test/partner/push-auth/challenges');
  assert.equal(call.headers['x-api-key'], 'nxs_test');
  assert.equal(call.headers['x-nexus-secret'], undefined);
  assert.deepEqual(JSON.parse(call.body), { identity: 'u1', method: 'number_match', details: { message: 'Sign in' } });
});

test('waitForChallenge long-polls until decided', async () => {
  const fetch = fakeFetch([200, pending()], [200, pending({ stage: null })], [200, pending({ status: 'approved', receipt: 'x.y.z' })]);
  const done = await client(fetch).waitForChallenge('pac_1');
  assert.equal(done.status, 'approved');
  assert.match(fetch.calls[1].url, /\/challenges\/pac_1\?wait=\d+$/);
});

test('waitForChallenge can stop at a stage (code display)', async () => {
  const fetch = fakeFetch([200, pending({ method: 'code_display' })], [200, pending({ method: 'code_display', stage: 'awaiting_code' })]);
  const c = await client(fetch).waitForChallenge('pac_1', { untilStage: 'awaiting_code' });
  assert.equal(c.stage, 'awaiting_code');
  assert.equal(fetch.calls.length, 2);
});

test('errors carry the server code', async () => {
  const fetch = fakeFetch([423, { error: { code: 'identity_locked', message: 'locked', details: { lockedUntil: 'x' } } }]);
  await assert.rejects(client(fetch).createChallenge({ identity: 'u', details: { message: 'm' } }), (e) => e instanceof PushAuthError && e.code === 'identity_locked' && e.status === 423);
});

test('verifyReceiptOffline checks an ES256 receipt against the JWKS', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'pak_1' };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ typ: 'nexus-push-auth+jwt', alg: 'ES256', kid: 'pak_1' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: 'https://services.inverge.net/push-auth/env1', aud: 'env1', sub: 'u1', iat: now, exp: now + 300, amr: ['hwk', 'user'] })).toString('base64url');
  const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  // env2's JWKS is fetched separately; serve the same key so the AUDIENCE check is what fails.
  const fetch = fakeFetch([200, { keys: [jwk] }], [200, { keys: [jwk] }], [200, { keys: [jwk] }]);
  const pa = client(fetch);
  const ok = await pa.verifyReceiptOffline(`${h}.${p}.${s}`, 'env1');
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.claims.amr, ['hwk', 'user']);
  assert.equal((await pa.verifyReceiptOffline(`${h}.${p}.${s}`, 'env2')).reason, 'token_audience');
  assert.equal((await pa.verifyReceiptOffline(`${h}.${p}.${s.slice(0, -4)}AAAA`, 'env1')).reason, 'token_signature');
});

test('verifyWebhook: HMAC over timestamp.nonce.body, with a replay window', () => {
  const body = '{"id":"pawh_1","event":"challenge.approved"}';
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_x').update(`${ts}.n1.${body}`).digest('hex');
  assert.equal(verifyWebhook({ body, signature: sig, timestamp: ts, nonce: 'n1' }, 'whsec_x'), true);
  assert.equal(verifyWebhook({ body: body + ' ', signature: sig, timestamp: ts, nonce: 'n1' }, 'whsec_x'), false);
  assert.equal(verifyWebhook({ body, signature: sig, timestamp: ts - 1000, nonce: 'n1' }, 'whsec_x'), false);
});
