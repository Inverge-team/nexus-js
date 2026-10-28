import type { DocStore, WhereOp } from './api';
import { toUpdateSpec, where as whereFilter } from './api';
import { DocStoreError } from './client';
import { applyUpdate, comparator, deepEqual, deepMerge, type Filter, Hlc, type JsonObject, matches, type SortKey } from './core';

// ── storage ────────────────────────────────────────────────────────────────

/** Where the offline cache persists. Values are JSON-serialisable. */
export interface OfflineStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key/value whose key starts with `prefix`. */
  entries(prefix: string): Promise<[string, unknown][]>;
}

/** In-memory storage (Node, tests, or "offline for this tab only"). */
export function memoryStorage(): OfflineStorage {
  const m = new Map<string, string>();
  return {
    async get(k) {
      const v = m.get(k);
      return v === undefined ? undefined : JSON.parse(v);
    },
    async set(k, v) {
      m.set(k, JSON.stringify(v));
    },
    async delete(k) {
      m.delete(k);
    },
    async entries(prefix) {
      return [...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)]);
    },
  };
}

/** Browser storage on IndexedDB — survives reloads and works offline. */
export function indexedDbStorage(name = 'nexus-docstore'): OfflineStorage {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const r = fn(d.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: async (k, v) => void (await tx('readwrite', (s) => s.put(v, k))),
    delete: async (k) => void (await tx('readwrite', (s) => s.delete(k))),
    async entries(prefix) {
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const [keys, values] = await Promise.all([tx('readonly', (s) => s.getAllKeys(range)), tx('readonly', (s) => s.getAll(range))]);
      return keys.map((k, i) => [String(k), values[i]]);
    },
  };
}

// ── model ──────────────────────────────────────────────────────────────────

interface LocalDoc {
  id: string;
  /** null = deleted (a tombstone until the delete is pushed / acknowledged). */
  data: JsonObject | null;
  /** Last version confirmed by the server (0 = never synced). */
  version: number;
  /** HLC per top-level field (and `$doc` for deletes). */
  clock: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface OutboxEntry {
  collection: string;
  id: string;
  /** The server version this local edit started from. */
  baseVersion: number;
  deleted: boolean;
  data: JsonObject | null;
  clock: Record<string, string>;
  /** Monotonic — tells an in-flight push apart from a newer local edit. */
  rev: number;
}

export interface OfflineConflict {
  collection: string;
  id: string;
  /** `rejected`: the collection is server-wins; `parked`: it's in the conflict inbox
   *  (manual strategy); `refused`: rules/schema/unique constraint refused the write. */
  kind: 'rejected' | 'parked' | 'refused';
  localData: JsonObject | null;
  serverData: JsonObject | null;
  error?: { code: string; message: string };
  conflictId?: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface OfflineOptions {
  /** Collections to replicate (only documents your user may read are pulled). */
  collections: string[];
  storage?: OfflineStorage;
  /** Stable id of this device for the HLC (generated and persisted if omitted). */
  deviceId?: string;
  /** Background pull cadence when no live poke arrives. Default 30 s. */
  pullIntervalMs?: number;
  /** Use the live socket's `sync.poke` to pull immediately. Default true. */
  live?: boolean;
  onConflict?: (c: OfflineConflict) => void;
  onStatus?: (s: SyncStatus, info: { pending: number; error?: DocStoreError }) => void;
}

export interface LocalSnapshot<T = JsonObject> {
  id: string;
  exists: boolean;
  data(): T | undefined;
  version: number;
  /** True while a local change hasn't been acknowledged by the server. */
  hasPendingWrites: boolean;
  fromCache: true;
  createdAt: Date;
  updatedAt: Date;
}

const PUSH_BATCH = 100;

// ── the engine ─────────────────────────────────────────────────────────────

/**
 * Local-first DocStore: reads and writes hit the local cache immediately
 * (and work with no network); a background engine replicates.
 *
 * PUSH sends each local change with the version it was made from and an HLC
 * per field, so the server can merge field-by-field (or apply the
 * collection's server-wins / manual strategy). PULL fetches everything changed
 * since the last checkpoint — only documents the user's rules allow — and
 * rebases still-pending local edits on top (newer field clock wins).
 */
export class OfflineStore {
  private readonly storage: OfflineStorage;
  private readonly docs = new Map<string, Map<string, LocalDoc>>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private hlc!: Hlc;
  private checkpoint = 0;
  private rev = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private debounce?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private stopWatch?: () => void;
  private readonly onlineHandler = () => this.scheduleSync(0);
  private ready: Promise<void>;
  status: SyncStatus = 'idle';

  constructor(
    private readonly store: DocStore,
    private readonly opts: OfflineOptions,
  ) {
    this.storage = opts.storage ?? (typeof indexedDB !== 'undefined' ? indexedDbStorage() : memoryStorage());
    this.ready = this.load();
  }

  /** Number of local changes not yet acknowledged by the server. */
  get pending(): number {
    return this.outbox.size;
  }

  /** Resolve once the cache is loaded from storage (reads before this see an empty cache). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async load(): Promise<void> {
    const node = (this.opts.deviceId ?? ((await this.storage.get('meta:node')) as string | undefined)) || `d${Math.random().toString(36).slice(2, 12)}`;
    await this.storage.set('meta:node', node);
    this.hlc = new Hlc(node.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'device');
    this.checkpoint = ((await this.storage.get('meta:checkpoint')) as number | undefined) ?? 0;
    for (const [k, v] of await this.storage.entries('doc:')) {
      const [collection = '', ...rest] = k.slice(4).split('/');
      this.col(collection).set(rest.join('/'), v as LocalDoc);
    }
    for (const [, v] of await this.storage.entries('out:')) {
      const e = v as OutboxEntry;
      this.outbox.set(`${e.collection}/${e.id}`, e);
      this.rev = Math.max(this.rev, e.rev);
    }
    this.start();
  }

  private start(): void {
    this.interval = setInterval(() => this.scheduleSync(0), this.opts.pullIntervalMs ?? 30_000);
    (this.interval as { unref?: () => void }).unref?.();
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
    if (this.opts.live !== false) {
      try {
        this.stopWatch = this.store.live().watch(this.opts.collections, () => this.scheduleSync(0));
      } catch {
        /* no socket.io-client: polling only */
      }
    }
    this.scheduleSync(0);
  }

  /** Stop syncing (the cache stays in storage). */
  stop(): void {
    clearInterval(this.interval);
    clearTimeout(this.debounce);
    clearTimeout(this.retryTimer);
    this.stopWatch?.();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
  }

  /** Wipe the local cache and outbox (e.g. on sign-out). Unsynced changes are lost. */
  async clear(): Promise<void> {
    for (const [k] of await this.storage.entries('doc:')) await this.storage.delete(k);
    for (const [k] of await this.storage.entries('out:')) await this.storage.delete(k);
    await this.storage.delete('meta:checkpoint');
    this.docs.clear();
    this.outbox.clear();
    this.checkpoint = 0;
    for (const set of this.listeners.values()) for (const fn of set) fn();
  }

  collection<T = JsonObject>(name: string): LocalCollection<T> {
    if (!this.opts.collections.includes(name)) throw new DocStoreError(`'${name}' is not replicated by this OfflineStore`, 'bad_request', 400);
    return new LocalCollection<T>(this, name);
  }

  // ── sync loop ────────────────────────────────────────────────────────────

  /** Push local changes, then pull remote ones. Resolves when caught up. */
  async sync(): Promise<void> {
    await this.ready;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.setStatus('syncing');
        await this.push();
        await this.pull();
      } while (this.again);
    })()
      .then(() => {
        this.retries = 0;
        this.setStatus('idle');
      })
      .catch((e: unknown) => {
        const err = e instanceof DocStoreError ? e : new DocStoreError(String(e), 'internal', 0);
        this.setStatus(err.code === 'network' ? 'offline' : 'error', err);
        // Back off and try again; local reads/writes keep working meanwhile.
        const wait = Math.min(60_000, 1000 * 2 ** this.retries++);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.scheduleSync(0), wait);
        (this.retryTimer as { unref?: () => void }).unref?.();
      })
      .finally(() => (this.running = null));
    return this.running;
  }

  private scheduleSync(delay: number): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sync(), delay);
    (this.debounce as { unref?: () => void }).unref?.();
  }

  private async push(): Promise<void> {
    while (this.outbox.size) {
      const batch = [...this.outbox.values()].slice(0, PUSH_BATCH);
      const res = await this.store.http.request<{ results: { index: number; status: string; version?: number; deleted?: boolean; doc?: { data: JsonObject; version: number; createdAt: string; updatedAt: string } | null; conflictId?: string; error?: { code: string; message: string } }[] }>(
        'POST',
        '/sync/push',
        {
          clientId: this.hlc.node,
          changes: batch.map((e) => ({ collection: e.collection, id: e.id, baseVersion: e.baseVersion, deleted: e.deleted, data: e.data ?? undefined, clock: e.clock })),
        },
      );
      for (const r of res.results) {
        const e = batch[r.index];
        if (!e) continue;
        const key = `${e.collection}/${e.id}`;
        const still = this.outbox.get(key)?.rev === e.rev; // no newer local edit meanwhile
        const server = r.doc ? { data: r.doc.data, version: r.doc.version, createdAt: r.doc.createdAt, updatedAt: r.doc.updatedAt } : null;
        if (r.status === 'ok' || r.status === 'noop') {
          if (still) {
            await this.dropOutbox(key);
            await this.adopt(e.collection, e.id, server, r.version ?? e.baseVersion);
          } else {
            // A newer local edit is waiting: keep it, now based on the acknowledged version.
            const next = this.outbox.get(key)!;
            next.baseVersion = r.version ?? next.baseVersion;
            await this.storage.set(`out:${key}`, next);
          }
          continue;
        }
        const kind = r.status === 'rejected' ? 'rejected' : r.status === 'conflict' ? 'parked' : 'refused';
        if (still) await this.dropOutbox(key);
        this.opts.onConflict?.({ collection: e.collection, id: e.id, kind, localData: e.deleted ? null : e.data, serverData: server?.data ?? null, error: r.error, conflictId: r.conflictId });
        if (server || r.deleted) await this.adopt(e.collection, e.id, server, r.version ?? 0);
        else if (kind === 'refused') await this.refetch(e.collection, e.id);
      }
    }
  }

  private async pull(): Promise<void> {
    for (;;) {
      const r = await this.store.http.request<{ documents: { collection: string; id: string; version: number; seq: number; deleted: boolean; data: JsonObject | null; updatedAt: string; clock: Record<string, string> }[]; checkpoint: { seq: number }; hasMore: boolean; resync: string[] }>(
        'POST',
        '/sync/pull',
        { collections: this.opts.collections, checkpoint: { seq: this.checkpoint }, limit: 500 },
      );
      if (r.resync.length) {
        // Tombstones were purged past our checkpoint: what we have may hide
        // deletes. Drop the synced (non-pending) copies and re-pull from zero.
        for (const c of r.resync) for (const [id] of this.col(c)) if (!this.outbox.has(`${c}/${id}`)) await this.remove(c, id);
        this.checkpoint = 0;
        continue;
      }
      for (const d of r.documents) {
        for (const t of Object.values(d.clock ?? {})) this.hlc.observe(t);
        const key = `${d.collection}/${d.id}`;
        const pending = this.outbox.get(key);
        if (!pending) {
          await this.adopt(d.collection, d.id, d.deleted ? null : { data: d.data ?? {}, version: d.version, createdAt: d.updatedAt, updatedAt: d.updatedAt }, d.version, d.clock);
          continue;
        }
        // Rebase the pending edit: for each top-level field the newer clock wins.
        const local = this.col(d.collection).get(d.id);
        if (!local || pending.deleted || d.deleted || !d.data) continue;
        const merged: JsonObject = {};
        const keys = new Set([...Object.keys(d.data), ...Object.keys(local.data ?? {})]);
        for (const k of keys) {
          const localWins = (local.clock[k] ?? '') > (d.clock?.[k] ?? '');
          const src = localWins ? local.data ?? {} : d.data;
          if (k in src) merged[k] = src[k];
        }
        await this.put(d.collection, { ...local, data: merged, updatedAt: d.updatedAt });
      }
      this.checkpoint = r.checkpoint.seq;
      await this.storage.set('meta:checkpoint', this.checkpoint);
      if (!r.hasMore) return;
    }
  }

  private async refetch(collection: string, id: string): Promise<void> {
    const snap = await this.store.collection(collection).doc(id).get().catch(() => null);
    if (!snap) return;
    await this.adopt(collection, id, snap.exists ? { data: snap.data() as JsonObject, version: snap.version, createdAt: snap.createdAt!.toISOString(), updatedAt: snap.updatedAt!.toISOString() } : null, snap.version);
  }

  /** Make the local copy equal the server's. */
  private async adopt(collection: string, id: string, server: { data: JsonObject; version: number; createdAt: string; updatedAt: string } | null, version: number, clock?: Record<string, string>): Promise<void> {
    if (!server) {
      await this.remove(collection, id);
      return;
    }
    const prev = this.col(collection).get(id);
    await this.put(collection, { id, data: server.data, version: server.version ?? version, clock: clock ?? prev?.clock ?? {}, createdAt: prev?.createdAt ?? server.createdAt, updatedAt: server.updatedAt });
  }

  // ── local writes ─────────────────────────────────────────────────────────

  /** @internal */
  async localWrite(collection: string, id: string, next: (cur: JsonObject | null) => { data: JsonObject | null; touched: string[] }): Promise<void> {
    await this.ready;
    const cur = this.col(collection).get(id) ?? null;
    const { data, touched } = next(cur?.data ?? null);
    const now = new Date().toISOString();
    const t = this.hlc.now();
    const clock = { ...(cur?.clock ?? {}) };
    if (data === null) clock.$doc = t;
    else for (const k of touched) clock[k] = t;
    const doc: LocalDoc = { id, data, version: cur?.version ?? 0, clock, createdAt: cur?.createdAt ?? now, updatedAt: now };
    await this.put(collection, doc);

    const key = `${collection}/${id}`;
    const prev = this.outbox.get(key);
    const entry: OutboxEntry = {
      collection,
      id,
      baseVersion: prev?.baseVersion ?? cur?.version ?? 0,
      deleted: data === null,
      data,
      // Accumulate clocks for every field changed since the last push.
      clock: data === null ? { $doc: t } : { ...(prev?.clock ?? {}), ...Object.fromEntries(touched.map((k) => [k, t])) },
      rev: ++this.rev,
    };
    this.outbox.set(key, entry);
    await this.storage.set(`out:${key}`, entry);
    this.scheduleSync(250);
  }

  // ── local reads ──────────────────────────────────────────────────────────

  /** @internal */
  async readDoc(collection: string, id: string): Promise<LocalSnapshot | null> {
    await this.ready;
    const d = this.col(collection).get(id);
    return d ? this.snap(collection, d) : null;
  }

  /** @internal */
  async readQuery(collection: string, filter: Filter | undefined, sort: SortKey[], limit: number | undefined): Promise<LocalSnapshot[]> {
    await this.ready;
    const rows = [...this.col(collection).values()].filter((d) => d.data !== null && matches(filter, d.id, d.data));
    rows.sort((a, b) => comparator(sort)({ id: a.id, data: a.data!, createdAt: a.createdAt, updatedAt: a.updatedAt }, { id: b.id, data: b.data!, createdAt: b.createdAt, updatedAt: b.updatedAt }));
    return rows.slice(0, limit ?? rows.length).map((d) => this.snap(collection, d));
  }

  /** @internal */
  listen(collection: string, fn: () => void): () => void {
    let set = this.listeners.get(collection);
    if (!set) this.listeners.set(collection, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private snap(collection: string, d: LocalDoc): LocalSnapshot {
    const pending = this.outbox.has(`${collection}/${d.id}`);
    return {
      id: d.id,
      exists: d.data !== null,
      data: () => (d.data === null ? undefined : (JSON.parse(JSON.stringify(d.data)) as JsonObject)),
      version: d.version,
      hasPendingWrites: pending,
      fromCache: true,
      createdAt: new Date(d.createdAt),
      updatedAt: new Date(d.updatedAt),
    };
  }

  private col(name: string): Map<string, LocalDoc> {
    let m = this.docs.get(name);
    if (!m) this.docs.set(name, (m = new Map()));
    return m;
  }

  private async put(collection: string, doc: LocalDoc): Promise<void> {
    const prev = this.col(collection).get(doc.id);
    this.col(collection).set(doc.id, doc);
    await this.storage.set(`doc:${collection}/${doc.id}`, doc);
    if (!prev || !deepEqual(prev, doc)) this.emit(collection);
  }

  private async remove(collection: string, id: string): Promise<void> {
    if (!this.col(collection).delete(id)) return;
    await this.storage.delete(`doc:${collection}/${id}`);
    this.emit(collection);
  }

  private async dropOutbox(key: string): Promise<void> {
    this.outbox.delete(key);
    await this.storage.delete(`out:${key}`);
    this.emit(key.split('/')[0] ?? '');
  }

  private emit(collection: string): void {
    for (const fn of this.listeners.get(collection) ?? []) fn();
  }

  private setStatus(s: SyncStatus, error?: DocStoreError): void {
    this.status = s;
    this.opts.onStatus?.(s, { pending: this.outbox.size, error });
  }

  /** @internal */
  newId(): string {
    const a = '0123456789abcdefghijklmnopqrstuvwxyz';
    let t = '';
    let n = Date.now();
    for (let i = 0; i < 9; i++) {
      t = a[n % 36] + t;
      n = Math.floor(n / 36);
    }
    let r = '';
    for (let i = 0; i < 11; i++) r += a[Math.floor(Math.random() * 36)];
    return t + r;
  }
}

// ── local refs & queries ───────────────────────────────────────────────────

export class LocalQuery<T = JsonObject> {
  constructor(
    protected readonly engine: OfflineStore,
    readonly collection: string,
    protected readonly filter?: Filter,
    protected readonly sort: SortKey[] = [],
    protected readonly max?: number,
  ) {}

  where(fieldOrFilter: string | Filter, op?: WhereOp, value?: unknown): LocalQuery<T> {
    const next = typeof fieldOrFilter === 'string' ? whereFilter(fieldOrFilter, op!, value) : fieldOrFilter;
    return new LocalQuery<T>(this.engine, this.collection, this.filter ? { $and: [this.filter, next] } : next, this.sort, this.max);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): LocalQuery<T> {
    return new LocalQuery<T>(this.engine, this.collection, this.filter, [...this.sort, { field: field === 'id' ? '$id' : field, dir }], this.max);
  }
  limit(n: number): LocalQuery<T> {
    return new LocalQuery<T>(this.engine, this.collection, this.filter, this.sort, n);
  }

  /** Evaluated on the local cache — instant, works offline. */
  async get(): Promise<LocalSnapshot<T>[]> {
    return (await this.engine.readQuery(this.collection, this.filter, this.sort, this.max)) as LocalSnapshot<T>[];
  }

  /** Re-runs on every local change (your writes AND synced remote ones). */
  onSnapshot(next: (docs: LocalSnapshot<T>[]) => void): () => void {
    let last = '';
    const run = () =>
      void this.get().then((docs) => {
        const sig = JSON.stringify(docs.map((d) => [d.id, d.version, d.hasPendingWrites, d.data()]));
        if (sig !== last) {
          last = sig;
          next(docs);
        }
      });
    const off = this.engine.listen(this.collection, run);
    run();
    return off;
  }
}

export class LocalCollection<T = JsonObject> extends LocalQuery<T> {
  doc(id: string): LocalDocumentRef<T> {
    return new LocalDocumentRef<T>(this.engine, this.collection, id);
  }
  /** Create locally with a time-sortable id; replicated in the background. */
  async add(data: T): Promise<LocalDocumentRef<T>> {
    const ref = this.doc(this.engine.newId());
    await ref.set(data);
    return ref;
  }
}

export class LocalDocumentRef<T = JsonObject> {
  constructor(
    private readonly engine: OfflineStore,
    readonly collection: string,
    readonly id: string,
  ) {}

  async get(): Promise<LocalSnapshot<T> | null> {
    const s = await this.engine.readDoc(this.collection, this.id);
    return s && s.exists ? (s as LocalSnapshot<T>) : null;
  }

  async set(data: T, opts: { merge?: boolean } = {}): Promise<void> {
    await this.engine.localWrite(this.collection, this.id, (cur) => {
      const next = opts.merge && cur ? (deepMerge(cur, data) as JsonObject) : (JSON.parse(JSON.stringify(data)) as JsonObject);
      const keys = new Set([...Object.keys(cur ?? {}), ...Object.keys(next)]);
      return { data: next, touched: [...keys].filter((k) => !deepEqual((cur ?? {})[k], next[k])) };
    });
  }

  /** Field values work offline too (`increment`, `arrayUnion`, `serverTimestamp`…);
   *  the server re-applies nothing — it merges the resulting fields by clock. */
  async update(update: JsonObject): Promise<void> {
    await this.engine.localWrite(this.collection, this.id, (cur) => {
      if (!cur) throw new DocStoreError(`Document '${this.collection}/${this.id}' does not exist locally`, 'not_found', 404);
      return applyUpdate(cur, toUpdateSpec(update));
    });
  }

  async delete(): Promise<void> {
    await this.engine.localWrite(this.collection, this.id, () => ({ data: null, touched: [] }));
  }

  onSnapshot(next: (s: LocalSnapshot<T> | null) => void): () => void {
    let last = '';
    const run = () =>
      void this.get().then((s) => {
        const sig = JSON.stringify(s ? [s.version, s.hasPendingWrites, s.data()] : null);
        if (sig !== last) {
          last = sig;
          next(s);
        }
      });
    const off = this.engine.listen(this.collection, run);
    run();
    return off;
  }
}
