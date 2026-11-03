import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessagingError, NexusMessaging } from '../dist/messaging/index.js';

/** Records requests; answers from a queue of [status, json] (or an Error to throw). */
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses.shift() ?? [200, {}];
    if (r instanceof Error) throw r;
    const [status, json] = r;
    return { ok: status < 300, status, async text() { return JSON.stringify(json); } };
  };
  fn.calls = calls;
  return fn;
}

const client = (fetch, extra = {}) =>
  new NexusMessaging({ apiKey: 'nxs_test', baseUrl: 'https://api.test/', fetch, ...extra });

test('a WhatsApp template send uses the API field names', async () => {
  const fetch = fakeFetch([202, { id: 'msg_1', status: 'queued' }]);
  const out = await client(fetch).send({
    channel: 'whatsapp', to: '+9647501234567', template: 'order_shipped', language: 'en_US', variables: { order_id: 'A-91', n: 3 },
  });
  assert.equal(out.id, 'msg_1');
  const [c] = fetch.calls;
  assert.equal(c.url, 'https://api.test/partner/messaging/messages');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['x-api-key'], 'nxs_test');
  assert.deepEqual(JSON.parse(c.body), {
    channel: 'whatsapp', to: '+9647501234567', templateKey: 'order_shipped', templateLocale: 'en_US',
    templateVariables: { order_id: 'A-91', n: '3' },
  });
});

test('structured content passes through untouched', async () => {
  const fetch = fakeFetch([202, {}]);
  const content = { type: 'photo', media: 'tgf_abcdefghijkl', replyMarkup: { inline_keyboard: [] } };
  await client(fetch).send({ channel: 'telegram', to: '@alice', content, body: 'caption', trackLinks: false });
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { channel: 'telegram', to: '@alice', content, body: 'caption', trackLinks: false });
});

test('every send carries an idempotency key, reused across retries', async () => {
  const fetch = fakeFetch([503, { error: { code: 'unavailable', message: 'x' } }], [202, { id: 'msg_2' }], [202, {}]);
  const m = client(fetch, { maxRetries: 1 });
  assert.equal((await m.send({ channel: 'whatsapp', to: '+1', body: 'x' })).id, 'msg_2');
  await m.send({ channel: 'whatsapp', to: '+1', body: 'x', idempotencyKey: 'order-91' });
  const [k1, k2, k3] = fetch.calls.map((c) => c.headers['Idempotency-Key']);
  assert.match(k1, /^nxs-/);
  assert.equal(k1, k2);
  assert.equal(k3, 'order-91');
});

test('a rejection throws MessagingError with the API code', async () => {
  const fetch = fakeFetch([400, { error: { code: 'content_rejected', message: 'Template "x" expects 2 parameter(s); 1 supplied.' } }]);
  await assert.rejects(client(fetch).send({ channel: 'whatsapp', to: '+1', template: 'x' }), (e) => {
    assert.ok(e instanceof MessagingError);
    assert.equal(e.code, 'content_rejected');
    assert.equal(e.status, 400);
    return true;
  });
  assert.equal(fetch.calls.length, 1); // 4xx is never retried
});

test('refuses a send with nothing to send', async () => {
  assert.throws(() => client(fakeFetch()).send({ channel: 'whatsapp', to: '+1' }), TypeError);
});

test('get and events', async () => {
  const fetch = fakeFetch([200, { id: 'msg 1', status: 'delivered' }], [200, { events: [{ type: 'delivered' }] }]);
  const m = client(fetch);
  assert.equal((await m.get('msg 1')).status, 'delivered');
  assert.deepEqual(await m.events('msg 1'), [{ type: 'delivered' }]);
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url]), [
    ['GET', 'https://api.test/partner/messaging/messages/msg%201'],
    ['GET', 'https://api.test/partner/messaging/messages/msg%201/events'],
  ]);
});

test('WhatsApp media upload is a raw body', async () => {
  const fetch = fakeFetch([201, { mediaId: '123' }]);
  const out = await client(fetch).uploadMedia({ file: new TextEncoder().encode('%PDF'), contentType: 'application/pdf', filename: 'invoice 1.pdf' });
  assert.equal(out.mediaId, '123');
  const [c] = fetch.calls;
  assert.equal(c.url, 'https://api.test/partner/messaging/media?filename=invoice%201.pdf');
  assert.equal(c.headers['content-type'], 'application/pdf');
  assert.equal(new TextDecoder().decode(c.body), '%PDF');
});

test('Telegram upload from a path guesses type and name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-'));
  const path = join(dir, 'photo.png');
  writeFileSync(path, Buffer.from([0x89, 0x50]));
  const fetch = fakeFetch([201, { uploadId: 'tgf_x' }]);
  await client(fetch).uploadTelegramFile({ file: path });
  const [c] = fetch.calls;
  assert.equal(c.url, 'https://api.test/partner/messaging/telegram/uploads?filename=photo.png');
  assert.equal(c.headers['content-type'], 'image/png');
});

test('verifications: start, check, cancel — start/check never retried', async () => {
  const fetch = fakeFetch([201, { id: 'ver_1' }], [200, { valid: true }], [200, {}], [503, {}]);
  const m = client(fetch, { maxRetries: 3 });
  const v = await m.verifications.start({ to: '+9647501234567', codeLength: 6, smsFallback: true });
  assert.equal((await m.verifications.check(v.id, 123456)).valid, true);
  await m.verifications.cancel('ver_1');
  await assert.rejects(m.verifications.start({ to: '+1' }), MessagingError);
  assert.equal(fetch.calls.length, 4);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { to: '+9647501234567', codeLength: 6, fallback: 'sms' });
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { code: '123456' });
  assert.equal(fetch.calls[2].url, 'https://api.test/partner/messaging/verifications/ver_1/cancel');
});

test('a network failure surfaces as MessagingError("network")', async () => {
  const fetch = fakeFetch(new Error('ECONNREFUSED'));
  await assert.rejects(client(fetch, { maxRetries: 0 }).get('m'), (e) => e.code === 'network');
});

test('NEXUS_MESSAGING_ENABLED=false makes no call and returns null', async () => {
  process.env.NEXUS_MESSAGING_ENABLED = 'false';
  try {
    const fetch = fakeFetch();
    const m = client(fetch);
    assert.equal(m.enabled(), false);
    assert.equal(await m.send({ channel: 'whatsapp', to: '+1', body: 'x' }), null);
    assert.equal(await m.verifications.start({ to: '+1' }), null);
    assert.equal(fetch.calls.length, 0);
  } finally {
    delete process.env.NEXUS_MESSAGING_ENABLED;
  }
});

test('requires an api key', () => {
  assert.throws(() => new NexusMessaging({}), /apiKey/);
});
