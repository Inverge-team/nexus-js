import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nexus, SERVICE_ENV } from '../dist/index.js';

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body || '{}') });
    return { ok: true, status: 200, async text() { return JSON.stringify({ sent: 1, ios: 1, flags: { new_checkout: true } }); } };
  };
  fn.calls = calls;
  return fn;
}

const boot = (fetch, extra = {}) =>
  Nexus.init(
    { apiKey: 'nxs_test', baseUrl: 'https://api.example.test', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent', fetch, ...extra },
    { force: true },
  );

/** Run fn with environment variables set, then restore. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('everything is on by default', () => {
  const n = boot(fakeFetch());
  for (const s of Object.keys(SERVICE_ENV)) assert.equal(n.enabled(s), true, s);
  n.dispose();
});

test('NEXUS_<SERVICE>_ENABLED=false switches one service off: no request, no throw', async () => {
  await withEnv({ NEXUS_LIVE_ACTIVITIES_ENABLED: 'false', NEXUS_PUSH_ENABLED: '0' }, async () => {
    const fetch = fakeFetch();
    const n = boot(fetch);
    assert.equal(n.enabled('liveActivities'), false);
    assert.equal(n.enabled('push'), false);

    const la = await n.liveActivities.template('order_tracking', 'o1').step('pending').toUser('u').start();
    assert.deepEqual(la, { ios: 0, android: 0 }); // the neutral result
    await n.liveActivities.activity('o1').step('arrived').update();
    await n.push.notification().title('Hi').toUser('u').send();
    assert.equal(fetch.calls.length, 0);

    // other services still work
    n.events.track('order_placed');
    await n.events.flush();
    assert.equal(fetch.calls.length, 1);
    assert.ok(fetch.calls[0].url.endsWith('/partner/events'));
    n.dispose();
  });
});

test('NEXUS_ENABLED=false switches everything off', async () => {
  await withEnv({ NEXUS_ENABLED: 'false' }, async () => {
    const fetch = fakeFetch();
    const n = boot(fetch);
    n.events.track('x');
    await n.events.flush();
    await n.flags.load();
    assert.equal(n.flags.isEnabled('new_checkout'), false); // off → not enabled (your fallback)
    await n.push.notification().title('Hi').toAll().send();
    assert.equal(fetch.calls.length, 0);
    for (const s of Object.keys(SERVICE_ENV)) assert.equal(n.enabled(s), false, s);
    n.dispose();
  });
});

test('config services (browsers) — and off wins over the environment', async () => {
  const fetch = fakeFetch();
  const n = boot(fetch, { services: { events: false } });
  n.events.track('x');
  await n.events.flush();
  assert.equal(fetch.calls.length, 0);
  n.dispose();

  // config says on, environment says off → off
  await withEnv({ NEXUS_PUSH_ENABLED: 'off' }, async () => {
    const f2 = fakeFetch();
    const m = boot(f2, { services: { push: true } });
    assert.equal(m.enabled('push'), false);
    m.dispose();
  });
});

test('a disabled realtime never opens a socket', async () => {
  const n = boot(fakeFetch(), { services: { realtime: false } });
  await n.realtime.connect();
  assert.equal(n.realtime.isConnected, false);
  assert.equal(await n.realtime.emit('orders:1', 'status', {}), null);
  n.dispose();
});

test('an unknown service key is rejected (a typo must not leave it on)', () => {
  assert.throws(() => boot(fakeFetch(), { services: { puhs: false } }), /unknown service "puhs"/);
});
