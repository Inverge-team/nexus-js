import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Nexus, resetBillingSuspension } from '../dist/index.js';

const SUSPENDED = {
  error: {
    code: 'billing_suspended',
    message: 'API access is suspended: USD 54.56 is past due on invoice INV-2026-10-0001.',
    details: { retryAfterSeconds: 300 },
  },
};

/** A fetch that answers from `script` (status per call), then 200. */
function fakeFetch(...script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body || '{}') });
    const status = script.shift() ?? 200;
    const body = status === 402 ? SUSPENDED : status === 4022 ? { error: { code: 'insufficient_balance', message: 'Top up' } } : { ok: true };
    const s = status === 4022 ? 402 : status;
    return { ok: s < 300, status: s, async text() { return JSON.stringify(body); }, async json() { return body; } };
  };
  fn.calls = calls;
  return fn;
}

const boot = (fetch) =>
  Nexus.init(
    { apiKey: 'nxs_test', baseUrl: 'https://api.example.test', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent', fetch },
    { force: true },
  );

beforeEach(() => resetBillingSuspension());

test('one 402 billing_suspended stops every further request', async () => {
  const fetch = fakeFetch(402);
  const n = boot(fetch);
  await n.errors.capture(new Error('first'));
  for (let i = 0; i < 50; i++) {
    await n.errors.capture(new Error(`again ${i}`));
    n.events.track('x');
    await n.events.flush();
    await n.push.notification().title('Hi').toUser('u').send();
  }
  assert.equal(fetch.calls.length, 1);
  n.dispose();
});

test('the pause is shared by every client in the process', async () => {
  const a = boot(fakeFetch(402));
  await a.errors.capture(new Error('trip'));
  a.dispose();
  const fetch = fakeFetch();
  const b = boot(fetch);
  await b.errors.capture(new Error('held back'));
  assert.equal(fetch.calls.length, 0);
  b.dispose();
});

test('an empty Messaging wallet (402 insufficient_balance) is not a suspension', async () => {
  const fetch = fakeFetch(4022);
  const n = boot(fetch);
  await n.errors.capture(new Error('not a suspension'));
  await n.errors.capture(new Error('still sent'));
  assert.equal(fetch.calls.length, 2);
  n.dispose();
});

test('resetBillingSuspension lets calls through again', async () => {
  const fetch = fakeFetch(402);
  const n = boot(fetch);
  await n.errors.capture(new Error('trip'));
  resetBillingSuspension();
  await n.errors.capture(new Error('after paying'));
  assert.equal(fetch.calls.length, 2);
  n.dispose();
});
