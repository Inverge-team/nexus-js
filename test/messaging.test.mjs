import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nexus } from '../dist/index.js';

/** A fake fetch that records requests and returns queued JSON responses. */
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body || '{}') });
    const r = responses.shift() ?? {};
    return { ok: true, status: 200, async text() { return JSON.stringify(r); } };
  };
  fn.calls = calls;
  return fn;
}

const boot = (fetch) =>
  Nexus.init({ apiKey: 'nxs_test', httpBase: 'https://api.example.test', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent', fetch });

test('push builder targets segments + users with options', async () => {
  const fetch = fakeFetch({ sent: 5, failed: 0, recipients: 5 });
  const n = boot(fetch);

  const res = await n.push
    .notification()
    .title('Flash sale')
    .body('50% off')
    .data({ screen: '/sale' })
    .button('shop', 'Shop', { url: 'https://x/sale' })
    .iosBadge(1)
    .androidVisibility('public')
    .setSegments(['vip', 'active_7d'])
    .toUsers(['u_9'])
    .send();

  assert.equal(res.recipients, 5);
  const call = fetch.calls.at(-1);
  assert.ok(call.url.endsWith('/partner/push/send'));
  assert.equal(call.body.title, 'Flash sale');
  assert.deepEqual(call.body.segmentIds, ['vip', 'active_7d']);
  assert.deepEqual(call.body.distinctIds, ['u_9']);
  assert.equal(call.body.options.iosBadge, 1);
  assert.equal(call.body.options.buttons[0].id, 'shop');
  assert.equal(call.body.options.buttons[0].action, 'url');
  n.dispose();
});

test('push builder validates title + target', async () => {
  const n = boot(fakeFetch());
  await assert.rejects(() => n.push.notification().toUsers(['u1']).send()); // no title
  await assert.rejects(() => n.push.notification().title('Hi').send()); // no target
  n.dispose();
});

test('inapp active + click', async () => {
  const fetch = fakeFetch({ messages: [{ id: 'm1' }] });
  const n = boot(fetch);

  const msgs = await n.inApp.active({ distinctId: 'u_1' });
  assert.equal(msgs[0].id, 'm1');
  assert.ok(fetch.calls.at(-1).url.endsWith('/partner/inapp/active'));

  await n.inApp.click('m1', 'cta', { distinctId: 'u_1' });
  const ev = fetch.calls.at(-1);
  assert.ok(ev.url.endsWith('/partner/inapp/event'));
  assert.equal(ev.body.type, 'click');
  assert.equal(ev.body.buttonId, 'cta');
  n.dispose();
});

test('live activity builder start/update/end', async () => {
  const fetch = fakeFetch({ ios: 1, android: 1 }, {}, {});
  const n = boot(fetch);

  const start = await n.liveActivities
    .activity('DeliveryAttributes', 'order_42')
    .title('Order #42')
    .status('Preparing')
    .progress(20)
    .toUser('u_1')
    .priority(10)
    .start();
  assert.equal(start.ios, 1);
  let call = fetch.calls.at(-1);
  assert.ok(call.url.endsWith('/partner/live-activities/start'));
  assert.equal(call.body.activityType, 'DeliveryAttributes');
  assert.equal(call.body.contentState.status, 'Preparing');
  assert.deepEqual(call.body.distinctIds, ['u_1']);
  assert.equal(call.body.priority, 10);

  await n.liveActivities.activity('order_42').status('On the way').progress(70).update();
  call = fetch.calls.at(-1);
  assert.ok(call.url.endsWith('/partner/live-activities/order_42/update'));
  assert.equal(call.body.contentState.status, 'On the way');

  await n.liveActivities.activity('order_42').status('Delivered').dismissAt('2026-01-01T12:00:00Z').end();
  call = fetch.calls.at(-1);
  assert.ok(call.url.endsWith('/partner/live-activities/order_42/end'));
  assert.equal(call.body.dismissalDate, '2026-01-01T12:00:00Z');
  n.dispose();
});

test('live activity builder start requires type', async () => {
  const n = boot(fakeFetch());
  await assert.rejects(() => n.liveActivities.activity('order_42').status('x').start());
  n.dispose();
});
