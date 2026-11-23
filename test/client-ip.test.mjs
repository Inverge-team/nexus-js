import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NexusMessaging, clientIpMiddleware, currentClientIp, runWithClientIp } from '../dist/messaging/index.js';

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, async text() { return '{"id":"x"}'; } };
  };
  fn.calls = calls;
  return fn;
}
const client = (fetch, extra = {}) => new NexusMessaging({ apiKey: 'nxs_test', baseUrl: 'https://api.test', fetch, ...extra });

test('a verification forwards the bound request address', async () => {
  const fetch = fakeFetch();
  await runWithClientIp('203.0.113.42', () => client(fetch).verifications.start({ to: '+9647501234567' }));
  assert.equal(fetch.calls[0].headers['X-Client-IP'], '203.0.113.42');
  assert.equal(fetch.calls[0].body.clientIp, undefined);
});

test('an explicit clientIp goes in the body and no header is added', async () => {
  const fetch = fakeFetch();
  await runWithClientIp('203.0.113.42', () => client(fetch).verifications.start({ to: '+9647501234567', clientIp: '198.51.100.7' }));
  assert.equal(fetch.calls[0].body.clientIp, '198.51.100.7');
  assert.equal(fetch.calls[0].headers['X-Client-IP'], undefined);
});

test('only OTP sends pick the address up by themselves', async () => {
  const fetch = fakeFetch();
  const m = client(fetch);
  await runWithClientIp('203.0.113.42', async () => {
    await m.send({ channel: 'sms', to: '+9647501234567', body: 'Your order shipped' });
    await m.send({ channel: 'sms', to: '+9647501234567', body: 'Code 1234', messageClass: 'otp' });
  });
  assert.equal(fetch.calls[0].headers['X-Client-IP'], undefined);
  assert.equal(fetch.calls[1].headers['X-Client-IP'], '203.0.113.42');
});

test('proxy, private and mapped addresses are filtered', () => {
  for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.0.4', '127.0.0.1', '100.64.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', 'nope']) {
    assert.equal(runWithClientIp(ip, () => currentClientIp()), null, ip);
  }
  assert.equal(runWithClientIp('::ffff:203.0.113.9', () => currentClientIp()), '203.0.113.9');
  assert.equal(runWithClientIp('2a00:1450:4001:81b::200e', () => currentClientIp()), '2a00:1450:4001:81b::200e');
});

test('forwarding can be switched off', async () => {
  const fetch = fakeFetch();
  await runWithClientIp('203.0.113.42', () => client(fetch, { forwardClientIp: false }).verifications.start({ to: '+9647501234567' }));
  assert.equal(fetch.calls[0].headers['X-Client-IP'], undefined);
});

test('the Express middleware binds req.ip for everything after it, across awaits', async () => {
  const fetch = fakeFetch();
  const mw = clientIpMiddleware();
  await new Promise((resolve) => {
    mw({ ip: '203.0.113.42' }, {}, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await client(fetch).verifications.start({ to: '+9647501234567' });
      resolve();
    });
  });
  assert.equal(fetch.calls[0].headers['X-Client-IP'], '203.0.113.42');
  assert.equal(currentClientIp(), null, 'nothing leaks outside the request');
});

test('a queued job re-binds the address it was given', async () => {
  const fetch = fakeFetch();
  const job = runWithClientIp('203.0.113.42', () => ({ phone: '+9647501234567', clientIp: currentClientIp() }));
  // later, in a worker
  await runWithClientIp(job.clientIp, () => client(fetch).verifications.start({ to: job.phone }));
  assert.equal(fetch.calls[0].headers['X-Client-IP'], '203.0.113.42');
});
