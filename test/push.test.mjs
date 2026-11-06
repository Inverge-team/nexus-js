import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nexus } from '../dist/index.js';

function fakeFetch(reply = { sent: 1, failed: 0, recipients: 1 }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, async text() { return JSON.stringify(reply); } };
  };
  fn.calls = calls;
  return fn;
}

const boot = (fetch) =>
  Nexus.init(
    { apiKey: 'nxs_test', baseUrl: 'https://api.example.test', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent', fetch },
    { force: true },
  );

test('when() applies the callback on a truthy value, otherwise the default', () => {
  const n = boot(fakeFetch());
  const ids = [];
  const p = n.push
    .notification()
    .title('Hi')
    .when('https://cdn.x/a.png', (b, url) => b.image(url))
    .when(null, (b) => b.body('never'))
    .when(ids, (b, v) => b.toUsers(v), (b) => b.toSegment('All Clients'))
    .when(() => true, (b) => b.data({ lazy: 1 }))
    .unless(false, (b) => b.iosBadge(1));
  assert.deepEqual(p.toJSON(), {
    title: 'Hi',
    imageUrl: 'https://cdn.x/a.png',
    data: { lazy: 1 },
    options: { iosBadge: 1 },
    segmentIds: ['All Clients'],
  });
  n.dispose();
});

test('empty optional values are no-ops', () => {
  const n = boot(fakeFetch());
  const p = n.push.notification().title('Hi').image(null).body('').toSegments(['']).toUsers(['', 'u1']).sendAt(null);
  assert.deepEqual(p.toJSON(), { title: 'Hi', distinctIds: ['u1'] });
  n.dispose();
});

test('sendAt schedules on /partner/push/send with an absolute instant', async () => {
  const fetch = fakeFetch({ id: 'c1', status: 'scheduled', scheduledAt: '2026-11-07T09:00:00.000Z', sentAt: null, recipients: 0, sent: 0, failed: 0 });
  const n = boot(fetch);
  const res = await n.push.notification().title('Hi').toUser('u1').name('Morning').schedule(new Date('2026-11-07T12:00:00+03:00'));
  assert.equal(res.id, 'c1');
  assert.deepEqual(fetch.calls[0].body, { title: 'Hi', distinctIds: ['u1'], sendAt: '2026-11-07T09:00:00.000Z', name: 'Morning' });
  assert.throws(() => n.push.notification().sendAt('2026-11-07T09:00:00'), /timezone offset/);

  await n.push.scheduled('c1');
  await n.push.cancelScheduled('c1');
  assert.deepEqual(fetch.calls.slice(1).map((c) => [c.method, c.url]), [
    ['GET', 'https://api.example.test/partner/push/scheduled/c1'],
    ['POST', 'https://api.example.test/partner/push/scheduled/c1/cancel'],
  ]);
  n.dispose();
});

test('title() and body() take one text per language', async () => {
  const fetch = fakeFetch();
  const n = boot(fetch);
  const p = n.push
    .notification()
    .title({ en: 'Your order shipped', ar: 'تم شحن طلبك', ckb: '' })
    .body({ en: 'Track it in the app', ar: '', ckb: 'بەدوایدا بچۆ' })
    .toUser('u1');
  assert.deepEqual(p.toJSON(), {
    title: 'Your order shipped',
    body: 'Track it in the app',
    localizations: {
      en: { title: 'Your order shipped', body: 'Track it in the app' },
      ar: { title: 'تم شحن طلبك', body: 'Track it in the app' },
      ckb: { title: 'Your order shipped', body: 'بەدوایدا بچۆ' },
    },
    defaultLanguage: 'en',
    distinctIds: ['u1'],
  });
  const d = n.push.notification().title({ ar: 'مرحبا', ckb: 'سڵاو' }).defaultLanguage('ckb').toUser('u').toJSON();
  assert.equal(d.title, 'سڵاو');
  assert.equal(d.defaultLanguage, 'ckb');

  await n.push.send(['u1'], { title: { en: 'Hi', ar: 'مرحبا' } });
  assert.deepEqual(fetch.calls[0].body.localizations.ar, { title: 'مرحبا' });
  assert.deepEqual(n.push.notification().title('Hi').toUser('u').toJSON(), { title: 'Hi', distinctIds: ['u'] });
  await assert.rejects(n.push.notification().title({ en: '' }).toUser('u').send(), /requires a title/);
  n.dispose();
});
