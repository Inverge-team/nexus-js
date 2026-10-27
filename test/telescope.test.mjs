import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NexusTelescope } from '../dist/telescope/index.js';

// One recorder per process: init once, with a fake ingest.
const sent = [];
const fakeFetch = async (url, init) => {
  if (String(url).includes('/partner/telescope')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ written: 1, config: { enabled: true, sampleRate: 1, slowRequestMs: 1000 } }), { status: 202 });
  }
  return globalThis.__realFetch(url, init);
};
globalThis.__realFetch = globalThis.fetch;
const telescope = NexusTelescope.init({ apiKey: 'nxs_test', baseUrl: 'http://ingest.test', service: 'node-test', fetch: fakeFetch, ignoreStatuses: ['418', '451-452'], flushIntervalMs: 60_000, instrument: { pg: false, mysql2: false, ioredis: false } });

const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const batches = () => sent.flatMap((p) => p.batches);
const reset = () => (sent.length = 0);

test('records concurrent requests in isolation, with nested spans, logs and an outgoing fetch that joins the trace', async () => {
  reset();
  const downstream = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tp: req.headers.traceparent ?? null }));
  });
  const port = downstream.address().port;
  const app = await listen(async (req, res) => {
    const n = req.url.split('/').pop();
    telescope.user({ id: n });
    await telescope.span('load', async () => {
      await sleep(5);
      telescope.query('select * from items where order_id = ?', [n], 1.2, 'pg');
    });
    console.log('handled order', n);
    const r = await fetch(`http://127.0.0.1:${port}/ping`);
    const body = await r.json();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ n, downstream: body.tp }));
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const [a, b] = await Promise.all([
    __realFetch(`${base}/orders/1`, { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } }).then((r) => r.json()),
    __realFetch(`${base}/orders/2`).then((r) => r.json()),
  ]);
  await sleep(20);
  await telescope.flush();

  const reqs = batches().filter((x) => x.type === 'request' && x.content.path.startsWith('/orders'));
  assert.equal(reqs.length, 2);
  const one = reqs.find((x) => x.content.path === '/orders/1');
  const two = reqs.find((x) => x.content.path === '/orders/2');
  assert.equal(one.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'joined the incoming trace');
  assert.equal(one.parentSpanId, '00f067aa0ba902b7');
  assert.notEqual(two.traceId, one.traceId);
  assert.deepEqual(one.user, { id: '1' });
  assert.deepEqual(two.user, { id: '2' }, 'concurrent requests never mix');

  const span = one.entries.find((e) => e.type === 'span');
  const q = one.entries.find((e) => e.type === 'query');
  assert.equal(q.parentId, span.id, 'a query after an await still nests under its span');
  assert.ok(span.durationMs >= 4);
  assert.deepEqual(q.content.bindings, ['1']);
  assert.ok(one.entries.some((e) => e.type === 'log' && e.content.message === 'handled order 1'));
  const call = one.entries.find((e) => e.type === 'http');
  assert.equal(call.status, '200');
  assert.ok(a.downstream.startsWith(`00-${one.traceId}-${call.id}`), 'the downstream got our traceparent, parented on the http entry');

  // The downstream server is instrumented too — it recorded its own request in the same trace.
  const ping = batches().find((x) => x.content.path === '/ping' && x.traceId === one.traceId);
  assert.ok(ping, 'downstream joined the trace');
  assert.equal(ping.parentSpanId, call.id);
  assert.equal(one.content.responseStatus, 200);
  assert.deepEqual(one.content.response, { n: '1', downstream: a.downstream });
  assert.equal(b.n, '2');
  app.close();
  downstream.close();
});

test('a job joins the trace of the request that queued it; failures are recorded', async () => {
  reset();
  let carrier;
  const app = await listen((req, res) => {
    carrier = { orderId: 7, ...telescope.inject('SendInvoice', 'emails') };
    res.statusCode = 500;
    telescope.exception(new Error('gateway down'), false);
    res.end('x');
  });
  await __realFetch(`http://127.0.0.1:${app.address().port}/checkout`);
  await sleep(10);
  await telescope.job('SendInvoice', async () => {
    telescope.cache('missed', 'invoice:7');
  }, { carrier, queue: 'emails' });
  await assert.rejects(telescope.command('reports:daily', async () => { throw new Error('boom'); }));
  await telescope.flush();

  const req = batches().find((x) => x.type === 'request');
  const job = batches().find((x) => x.type === 'job');
  const cmd = batches().find((x) => x.type === 'command');
  const dispatch = req.entries.find((e) => e.type === 'job');
  assert.equal(dispatch.status, 'dispatched');
  assert.equal(job.traceId, req.traceId);
  assert.equal(job.parentSpanId, dispatch.id);
  assert.equal(job.status, 'processed');
  assert.ok(job.entries.some((e) => e.type === 'cache'));
  const ex = req.entries.find((e) => e.type === 'exception');
  assert.equal(ex.content.message, 'gateway down');
  assert.ok(ex.content.stack.length > 0);
  assert.equal(cmd.status, '1');
  assert.ok(cmd.entries.some((e) => e.type === 'exception'));
  app.close();
});

test('requests answered with an ignored status are never sent', async () => {
  reset();
  const app = await listen((req, res) => {
    telescope.query('select 1', [], 0.1, 'pg');
    res.statusCode = Number(req.url.slice(1));
    res.end('x');
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const s of [418, 451, 452, 404]) await __realFetch(`${base}/${s}`);
  await sleep(10);
  await telescope.flush();
  const statuses = batches().filter((x) => x.type === 'request').map((x) => x.content.responseStatus);
  assert.deepEqual(statuses, [404]);
  assert.ok(telescope.recorder.ignoresStatus(451) && !telescope.recorder.ignoresStatus('453'));
  app.close();
});

test('ignored paths are not recorded and secrets are redacted', async () => {
  reset();
  const app = await listen((req, res) => res.end('ok'));
  const base = `http://127.0.0.1:${app.address().port}`;
  await __realFetch(`${base}/health`);
  await __realFetch(`${base}/login`, { headers: { authorization: 'Bearer secret', cookie: 'a=b' } });
  await sleep(10);
  await telescope.flush();
  const paths = batches().map((x) => x.content.path);
  assert.ok(!paths.includes('/health'));
  const login = batches().find((x) => x.content.path === '/login');
  assert.equal(login.content.headers.authorization, '********');
  assert.equal(login.content.headers.cookie, '********');
  app.close();
});
