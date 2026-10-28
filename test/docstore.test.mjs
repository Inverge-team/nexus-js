import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrayRemove,
  arrayUnion,
  createDocStore,
  DocStoreError,
  deleteField,
  increment,
  memoryStorage,
  or,
  serverTimestamp,
  toUpdateSpec,
  where,
} from '../dist/docstore/index.js';
import { Nexus } from '../dist/index.js';

/** A fake DocStore server: records calls, answers from `routes`. */
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = `${init.method} ${u.pathname.replace('/partner/docstore', '')}`;
    calls.push({ key, url: u, body, headers: init.headers });
    const handler = routes[key];
    const [status, json] = handler ? await handler(body, u) : [404, { error: { code: 'not_found', message: 'no route' } }];
    return { ok: status < 400, status, async text() { return json === undefined ? '' : JSON.stringify(json); } };
  };
  return { fetch, calls };
}

const doc = (id, data, version = 1) => ({ id, data, version, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' });

test('field values compile to server update operators', () => {
  assert.deepEqual(
    toUpdateSpec({ views: increment(2), tags: arrayUnion('a', 'b'), old: arrayRemove('x'), at: serverTimestamp(), draft: deleteField(), 'profile.name': 'Ana' }),
    { $inc: { views: 2 }, $addToSet: { tags: { $each: ['a', 'b'] } }, $pull: { old: { $in: ['x'] } }, $serverTime: ['at'], $unset: ['draft'], $set: { 'profile.name': 'Ana' } },
  );
  assert.deepEqual(toUpdateSpec({ $inc: { n: 1 } }), { $inc: { n: 1 } }, 'raw operators pass through');
});

test('query builder produces the server JSON, and sends the end-user token', async () => {
  const s = fakeServer({ 'POST /collections/orders/query': () => [200, { items: [doc('o1', { total: 5 })], nextCursor: 'c1', hasMore: true }] });
  const db = createDocStore({ apiKey: 'nxs_k', baseUrl: 'https://api.test', fetch: s.fetch, getToken: () => 'user-jwt' });
  const page = await db
    .collection('orders')
    .where('status', 'in', ['open', 'paid'])
    .where(or(where('total', '>=', 100), where('vip', '==', true)))
    .orderBy('total', 'desc')
    .limit(20)
    .expand('user')
    .get();
  const c = s.calls[0];
  assert.equal(c.headers.authorization, 'Bearer user-jwt');
  assert.equal(c.headers['x-api-key'], 'nxs_k');
  assert.deepEqual(c.body, {
    filter: { $and: [{ status: { $in: ['open', 'paid'] } }, { $or: [{ total: { $gte: 100 } }, { vip: { $eq: true } }] }] },
    sort: [{ field: 'total', dir: 'desc' }],
    limit: 20,
    expand: ['user'],
  });
  assert.equal(page.docs[0].data().total, 5);
  assert.equal(page.nextCursor, 'c1');
});

test('errors are typed; missing docs read as exists=false', async () => {
  const s = fakeServer({
    'GET /collections/posts/docs/nope': () => [404, { error: { code: 'not_found', message: 'gone' } }],
    'GET /collections/posts/docs/secret': () => [403, { error: { code: 'permission_denied', message: 'read on posts denied by rules' } }],
  });
  const db = createDocStore({ apiKey: 'k', fetch: s.fetch });
  assert.equal((await db.doc('posts/nope').get()).exists, false);
  await assert.rejects(() => db.doc('posts/secret').get(), (e) => e instanceof DocStoreError && e.code === 'permission_denied' && e.status === 403);
});

test('a 401 retries once with a force-refreshed token', async () => {
  let n = 0;
  const s = fakeServer({ 'GET /collections/a/docs/1': () => (++n === 1 ? [401, { error: { code: 'unauthorized', message: 'expired' } }] : [200, doc('1', { ok: true })]) });
  const forced = [];
  const db = createDocStore({ apiKey: 'k', fetch: s.fetch, getToken: ({ forceRefresh }) => (forced.push(forceRefresh), forceRefresh ? 'fresh' : 'stale') });
  assert.equal((await db.doc('a/1').get()).data().ok, true);
  assert.deepEqual(forced, [false, true]);
  assert.equal(s.calls[1].headers.authorization, 'Bearer fresh');
});

test('runTransaction guards writes with read versions and retries on a race', async () => {
  let balance = 100;
  let version = 3;
  let commits = 0;
  const s = fakeServer({
    'GET /collections/accounts/docs/a': () => [200, doc('a', { balance }, version)],
    'POST /commit': (body) => {
      commits++;
      const op = body.operations[0];
      if (commits === 1) {
        // Someone else wrote in between.
        version++;
        return [409, { error: { code: 'conflict', message: 'precondition', details: { reason: 'precondition_failed' } } }];
      }
      assert.equal(op.precondition.version, version);
      balance = op.data.balance;
      return [200, { results: [{ index: 0, status: 'ok', id: 'a', version: ++version }] }];
    },
  });
  const db = createDocStore({ apiKey: 'k', fetch: s.fetch });
  const ref = db.doc('accounts/a');
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    tx.set(ref, { balance: snap.data().balance - 30 });
    return 'done';
  });
  assert.equal(out, 'done');
  assert.equal(commits, 2);
  assert.equal(balance, 70);
});

test('switched off → service_disabled, no request', async () => {
  const s = fakeServer({});
  const n = Nexus.init({ apiKey: 'nxs_k', baseUrl: 'https://api.test', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent', fetch: s.fetch, services: { docstore: false } }, { force: true });
  await assert.rejects(() => n.docstore().doc('a/b').get(), (e) => e.code === 'service_disabled');
  assert.equal(s.calls.filter((c) => c.key.includes('docstore')).length, 0);
  n.dispose();
});

// ── offline engine ──────────────────────────────────────────────────────────

/** A tiny in-memory server implementing sync pull/push with field merge. */
function syncServer() {
  const docs = new Map(); // id -> { data, version, seq, clock, deleted }
  let seq = 0;
  const routes = {
    'POST /sync/pull': (body) => {
      const since = body.checkpoint?.seq ?? 0;
      const out = [...docs.entries()].filter(([, d]) => d.seq > since).sort((a, b) => a[1].seq - b[1].seq).map(([id, d]) => ({ collection: 'todos', id, version: d.version, seq: d.seq, deleted: d.deleted, data: d.deleted ? null : d.data, updatedAt: '2026-10-28T00:00:00.000Z', clock: d.clock }));
      return [200, { documents: out, checkpoint: { seq: out.length ? out[out.length - 1].seq : since }, hasMore: false, resync: [] }];
    },
    'POST /sync/push': (body) => {
      const results = body.changes.map((c, index) => {
        const cur = docs.get(c.id);
        let data = c.data;
        let clock = c.clock;
        let merged = false;
        if (cur && cur.version !== c.baseVersion) {
          // field-level LWW, like the real server's `merge` strategy
          merged = true;
          data = {};
          clock = {};
          for (const k of new Set([...Object.keys(cur.data), ...Object.keys(c.data ?? {})])) {
            const mine = (c.clock[k] ?? '') > (cur.clock[k] ?? '');
            const src = mine ? c.data : cur.data;
            if (k in src) data[k] = src[k];
            clock[k] = mine ? c.clock[k] : cur.clock[k];
          }
        }
        const version = (cur?.version ?? 0) + 1;
        docs.set(c.id, { data: c.deleted ? cur?.data : data, version, seq: ++seq, clock: { ...(cur?.clock ?? {}), ...clock }, deleted: !!c.deleted });
        return { index, status: 'ok', id: c.id, version, merged, deleted: !!c.deleted, doc: c.deleted ? null : doc(c.id, data, version) };
      });
      return [200, { results }];
    },
  };
  return { routes, docs, bump: (id, data, clockTime) => docs.set(id, { data, version: (docs.get(id)?.version ?? 0) + 1, seq: ++seq, clock: Object.fromEntries(Object.keys(data).map((k) => [k, clockTime])), deleted: false }) };
}

test('offline: local writes are instant, then replicate; remote edits to other fields merge', async () => {
  const srv = syncServer();
  const s = fakeServer(srv.routes);
  const db = createDocStore({ apiKey: 'k', fetch: s.fetch });
  const off = db.offline({ collections: ['todos'], storage: memoryStorage(), live: false, deviceId: 'devA', pullIntervalMs: 60_000 });
  await off.whenReady();

  const todos = off.collection('todos');
  await todos.doc('t1').set({ title: 'Buy milk', done: false });
  const local = await todos.doc('t1').get();
  assert.equal(local.data().title, 'Buy milk');
  assert.equal(local.hasPendingWrites, true);

  await off.sync();
  assert.equal(off.pending, 0);
  assert.equal(srv.docs.get('t1').data.title, 'Buy milk');
  assert.equal((await todos.doc('t1').get()).version, 1);

  // Another device renames it on the server while we (offline) tick it done.
  srv.bump('t1', { title: 'Buy oat milk', done: false }, '0000000000001-0000-devB');
  await todos.doc('t1').update({ done: true });
  await off.sync();
  const merged = (await todos.doc('t1').get()).data();
  assert.deepEqual(merged, { title: 'Buy oat milk', done: true }, 'both edits survive');
  assert.equal(srv.docs.get('t1').data.done, true);
  off.stop();
});

test('offline: local queries match server semantics and update live', async () => {
  const srv = syncServer();
  const s = fakeServer(srv.routes);
  const off = createDocStore({ apiKey: 'k', fetch: s.fetch }).offline({ collections: ['todos'], storage: memoryStorage(), live: false, pullIntervalMs: 60_000 });
  await off.whenReady();
  const todos = off.collection('todos');
  const seen = [];
  const stop = todos.where('done', '==', false).orderBy('rank').onSnapshot((docs) => seen.push(docs.map((d) => d.id)));
  await todos.doc('b').set({ done: false, rank: 2 });
  await todos.doc('a').set({ done: false, rank: 1 });
  await todos.doc('c').set({ done: true, rank: 0 });
  await todos.doc('d').set({ done: false, rank: '1' }); // a string rank sorts before numbers (jsonb order)
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen.at(-1), ['d', 'a', 'b']);
  const ranked = await todos.where('rank', '>', 0).get();
  assert.deepEqual(ranked.map((d) => d.id).sort(), ['a', 'b'], 'type-bracketed: the string "1" is not > 0');
  await todos.doc('a').delete();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen.at(-1), ['d', 'b']);
  stop();
  off.stop();
});

test('offline: the cache and outbox survive a restart', async () => {
  const storage = memoryStorage();
  const s = fakeServer({ 'POST /sync/push': () => { throw new Error('offline'); }, 'POST /sync/pull': () => { throw new Error('offline'); } });
  const db = createDocStore({ apiKey: 'k', fetch: s.fetch });
  const first = db.offline({ collections: ['todos'], storage, live: false, pullIntervalMs: 60_000 });
  await first.whenReady();
  await first.collection('todos').doc('x').set({ title: 'Written offline' });
  first.stop();
  const second = db.offline({ collections: ['todos'], storage, live: false, pullIntervalMs: 60_000 });
  await second.whenReady();
  assert.equal((await second.collection('todos').doc('x').get()).data().title, 'Written offline');
  assert.equal(second.pending, 1);
  second.stop();
});
