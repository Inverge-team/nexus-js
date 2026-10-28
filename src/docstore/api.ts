import { type DocData, DocStoreError, type DocStoreHttp, type QueryBody, type WriteResultBody } from './client';
import { type Filter, isOperatorUpdate, type JsonObject, type SortKey } from './core';
import type { DocStoreLive, LiveChange } from './live';

// ── field values (Firestore-style sentinels → server update operators) ─────

const FV = Symbol.for('nexus.docstore.fieldValue');
type FieldValueKind = 'inc' | 'mul' | 'min' | 'max' | 'union' | 'remove' | 'push' | 'serverTime' | 'delete' | 'merge';
export interface FieldValue {
  readonly [FV]: FieldValueKind;
  readonly value?: unknown;
  readonly slice?: number;
}
const fv = (kind: FieldValueKind, value?: unknown, slice?: number): FieldValue => ({ [FV]: kind, value, slice });

/** Atomically add `n` (server-side, under a row lock — concurrent increments never lose). */
export const increment = (n: number) => fv('inc', n);
export const multiply = (n: number) => fv('mul', n);
/** Keep the smaller / larger of the stored value and `v`. */
export const minimum = (v: number | string) => fv('min', v);
export const maximum = (v: number | string) => fv('max', v);
/** Add values to an array if absent. */
export const arrayUnion = (...values: unknown[]) => fv('union', values);
/** Remove every occurrence of these values from an array. */
export const arrayRemove = (...values: unknown[]) => fv('remove', values);
/** Append values (duplicates allowed); `keepLast` caps the array (e.g. a rolling log). */
export const arrayPush = (values: unknown[], opts: { keepLast?: number } = {}) => fv('push', values, opts.keepLast ? -opts.keepLast : undefined);
/** The server's clock at commit time (ISO string). */
export const serverTimestamp = () => fv('serverTime');
/** Remove the field. */
export const deleteField = () => fv('delete');
/** Deep-merge an object into the field (null values delete keys). */
export const mergeField = (value: JsonObject) => fv('merge', value);

function isFieldValue(v: unknown): v is FieldValue {
  return typeof v === 'object' && v !== null && FV in (v as object);
}

/** `{ views: increment(1), 'profile.name': 'Ana' }` → `{ $inc: {views: 1}, $set: {'profile.name': 'Ana'} }`.
 *  A body that already uses `$` operators is passed through. */
export function toUpdateSpec(update: JsonObject): JsonObject {
  if (isOperatorUpdate(update)) return update;
  const spec: Record<string, JsonObject | string[]> = {};
  const put = (op: string, field: string, value: unknown) => ((spec[op] ??= {}) as JsonObject)[field] = value;
  const list = (op: string, field: string) => ((spec[op] ??= []) as string[]).push(field);
  for (const [field, v] of Object.entries(update)) {
    if (!isFieldValue(v)) {
      put('$set', field, v);
      continue;
    }
    switch (v[FV]) {
      case 'inc': put('$inc', field, v.value); break;
      case 'mul': put('$mul', field, v.value); break;
      case 'min': put('$min', field, v.value); break;
      case 'max': put('$max', field, v.value); break;
      case 'union': put('$addToSet', field, { $each: v.value }); break;
      case 'remove': put('$pull', field, { $in: v.value }); break;
      case 'push': put('$push', field, v.slice ? { $each: v.value, $slice: v.slice } : { $each: v.value }); break;
      case 'serverTime': list('$serverTime', field); break;
      case 'delete': list('$unset', field); break;
      case 'merge': put('$merge', field, v.value); break;
    }
  }
  return spec;
}

// ── snapshots ──────────────────────────────────────────────────────────────

export class DocumentSnapshot<T = JsonObject> {
  constructor(
    readonly ref: DocumentRef<T>,
    private readonly raw: DocData<T> | null,
  ) {}
  get id(): string {
    return this.ref.id;
  }
  get exists(): boolean {
    return this.raw !== null;
  }
  /** The document's data, or undefined when it doesn't exist. */
  data(): T | undefined {
    return this.raw?.data;
  }
  /** Read one field by dot path. */
  get<V = unknown>(path: string): V | undefined {
    let cur: unknown = this.raw?.data;
    for (const s of path.split('.')) cur = cur && typeof cur === 'object' ? (cur as JsonObject)[s] : undefined;
    return cur as V | undefined;
  }
  get version(): number {
    return this.raw?.version ?? 0;
  }
  get createdAt(): Date | null {
    return this.raw ? new Date(this.raw.createdAt) : null;
  }
  get updatedAt(): Date | null {
    return this.raw ? new Date(this.raw.updatedAt) : null;
  }
  /** Related documents requested with `expand`. */
  get expand(): Record<string, unknown> {
    return this.raw?.expand ?? {};
  }
}

export interface QuerySnapshot<T> {
  docs: DocumentSnapshot<T>[];
  size: number;
  empty: boolean;
  /** Pass to `query.startAfter(cursor)` for the next page. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Present when the query asked for `withCount()`. */
  total?: number;
}

export interface LiveQuerySnapshot<T> {
  docs: DocumentSnapshot<T>[];
  /** What changed since the previous snapshot (empty on the first one). */
  changes: { type: 'added' | 'modified' | 'removed'; doc: DocumentSnapshot<T>; index: number; oldIndex: number }[];
  hasMore: boolean;
}

export type Aggregations = Record<string, { op: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'; field?: string }>;
export const count = () => ({ op: 'count' as const });
export const countDistinct = (field: string) => ({ op: 'countDistinct' as const, field });
export const sum = (field: string) => ({ op: 'sum' as const, field });
export const avg = (field: string) => ({ op: 'avg' as const, field });
export const min = (field: string) => ({ op: 'min' as const, field });
export const max = (field: string) => ({ op: 'max' as const, field });

export interface AggregateResult {
  groups: { key: Record<string, unknown>; values: Record<string, number | null> }[];
}

// ── query builder ──────────────────────────────────────────────────────────

export type WhereOp =
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'in' | 'not-in' | 'between'
  | 'array-contains' | 'array-contains-any' | 'array-contains-all'
  | 'starts-with' | 'ends-with' | 'matches' | 'exists' | 'size' | 'type';

const OP: Record<WhereOp, string> = {
  '==': '$eq', '!=': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte',
  in: '$in', 'not-in': '$nin', between: '$between',
  'array-contains': '$contains', 'array-contains-any': '$containsAny', 'array-contains-all': '$containsAll',
  'starts-with': '$startsWith', 'ends-with': '$endsWith', matches: '$regex', exists: '$exists', size: '$size', type: '$type',
};

/** A single condition, for composing with {@link or} / {@link and}. */
export function where(field: string, op: WhereOp, value: unknown): Filter {
  return { [field === 'id' ? '$id' : field]: { [OP[op]]: value } };
}
export const or = (...filters: Filter[]): Filter => ({ $or: filters });
export const and = (...filters: Filter[]): Filter => ({ $and: filters });
export const not = (filter: Filter): Filter => ({ $not: filter });
/** Match through a relation: `whereRelated('author', where('verified', '==', true))`. */
export const whereRelated = (relation: string, filter: Filter): Filter => ({ [relation]: { $rel: filter } });

export class Query<T = JsonObject> {
  constructor(
    protected readonly store: DocStore,
    readonly collection: string,
    protected readonly body: QueryBody = {},
  ) {}

  protected with(patch: Partial<QueryBody>): this {
    const Ctor = this.constructor as new (s: DocStore, c: string, b: QueryBody) => this;
    return new Ctor(this.store, this.collection, { ...this.body, ...patch });
  }

  /** `where('status', '==', 'open')`, or pass a composed filter (`or(...)`, raw JSON filter). */
  where(fieldOrFilter: string | Filter, op?: WhereOp, value?: unknown): this {
    const next = typeof fieldOrFilter === 'string' ? where(fieldOrFilter, op!, value) : fieldOrFilter;
    const cur = this.body.filter;
    return this.with({ filter: cur ? { $and: [cur, next] } : next });
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): this {
    return this.with({ sort: [...(this.body.sort ?? []), { field: field === 'id' ? '$id' : field, dir }] });
  }
  limit(n: number): this {
    return this.with({ limit: n });
  }
  /** Keyset pagination: the `nextCursor` of the previous page. */
  startAfter(cursor: string): this {
    return this.with({ cursor });
  }
  offset(n: number): this {
    return this.with({ offset: n });
  }
  /** Return only these fields (dot paths). */
  select(...fields: string[]): this {
    return this.with({ select: fields });
  }
  /** Inline related documents: `expand('author', 'comments', 'author.company')`. */
  expand(...relations: string[]): this {
    return this.with({ expand: [...(this.body.expand ?? []), ...relations] });
  }
  /** Full-text search over the collection's search fields. */
  search(text: string): this {
    return this.with({ search: text });
  }
  /** Time travel: read the collection as it was at `when`. */
  asOf(when: Date | string): this {
    return this.with({ asOf: typeof when === 'string' ? when : when.toISOString() });
  }
  /** Also return the total number of matches. */
  withCount(): this {
    return this.with({ count: true });
  }

  toJSON(): QueryBody {
    return { ...this.body };
  }

  async get(): Promise<QuerySnapshot<T>> {
    const r = await this.store.http.request<{ items: DocData<T>[]; nextCursor: string | null; hasMore: boolean; total?: number }>(
      'POST',
      `/collections/${enc(this.collection)}/query`,
      this.body,
    );
    const docs = r.items.map((d) => new DocumentSnapshot<T>(this.store.collection<T>(this.collection).doc(d.id), d));
    return { docs, size: docs.length, empty: docs.length === 0, nextCursor: r.nextCursor, hasMore: r.hasMore, total: r.total };
  }

  /** Iterate every match, page by page. */
  async *all(pageSize = 200): AsyncGenerator<DocumentSnapshot<T>> {
    let q = this.limit(pageSize);
    for (;;) {
      const page = await q.get();
      yield* page.docs;
      if (!page.nextCursor) return;
      q = q.startAfter(page.nextCursor);
    }
  }

  async count(): Promise<number> {
    const r = await this.aggregate({ n: count() });
    return (r.groups[0]?.values.n as number) ?? 0;
  }

  aggregate(aggregations: Aggregations, opts: { groupBy?: string[]; limit?: number } = {}): Promise<AggregateResult> {
    return this.store.http.request('POST', `/collections/${enc(this.collection)}/aggregate`, {
      filter: this.body.filter,
      search: this.body.search,
      asOf: this.body.asOf,
      aggregations,
      groupBy: opts.groupBy,
      limit: opts.limit,
    });
  }

  /** Live results: the snapshot now, then every change — security rules applied server-side. */
  onSnapshot(next: (s: LiveQuerySnapshot<T>) => void, error?: (e: DocStoreError) => void): () => void {
    if (this.body.asOf) throw new DocStoreError('A time-travel (asOf) query is a fixed past state and cannot be live', 'bad_request', 400);
    let docs: DocumentSnapshot<T>[] = [];
    const col = this.store.collection<T>(this.collection);
    const snap = (d: DocData<T>) => new DocumentSnapshot<T>(col.doc(d.id), d);
    return this.store.live().subscribe(
      { collection: this.collection, kind: 'query', filter: this.body.filter, sort: this.body.sort, limit: this.body.limit, search: this.body.search, select: this.body.select },
      {
        onSnapshot: (ack) => {
          docs = ((ack.items as DocData<T>[]) ?? []).map(snap);
          next({ docs: [...docs], changes: docs.map((d, i) => ({ type: 'added', doc: d, index: i, oldIndex: -1 })), hasMore: Boolean(ack.hasMore) });
        },
        onChanges: (changes: LiveChange[], meta) => {
          const out: LiveQuerySnapshot<T>['changes'] = [];
          for (const c of changes) {
            if (c.type === 'removed') {
              const i = docs.findIndex((d) => d.id === c.id);
              const gone = i >= 0 ? docs.splice(i, 1)[0] : undefined;
              if (gone) out.push({ type: 'removed', doc: gone, index: -1, oldIndex: c.oldIndex });
              continue;
            }
            const i = docs.findIndex((d) => d.id === c.doc.id);
            if (i >= 0) docs.splice(i, 1);
            const d = snap(c.doc as DocData<T>);
            docs.splice(Math.min(c.index, docs.length), 0, d);
            out.push({ type: c.type, doc: d, index: c.index, oldIndex: c.type === 'modified' ? c.oldIndex : -1 });
          }
          next({ docs: [...docs], changes: out, hasMore: meta.hasMore });
        },
        onError: (code, message) => error?.(new DocStoreError(message, code, 0)),
      },
    );
  }

  /** A live aggregate (count/sum/avg/min/max, optional group-by) that re-computes as data changes. */
  onAggregate(aggregations: Aggregations, next: (r: AggregateResult) => void, opts: { groupBy?: string[]; error?: (e: DocStoreError) => void } = {}): () => void {
    return this.store.live().subscribe(
      { collection: this.collection, kind: 'aggregate', filter: this.body.filter, search: this.body.search, aggregations, groupBy: opts.groupBy },
      {
        onSnapshot: (ack) => next(ack.result as AggregateResult),
        onAggregate: (r) => next(r as AggregateResult),
        onError: (code, message) => opts.error?.(new DocStoreError(message, code, 0)),
      },
    );
  }
}

// ── references ─────────────────────────────────────────────────────────────

export interface SetOptions {
  /** Deep-merge into the existing document instead of replacing it. */
  merge?: boolean;
  /** Only write if the document is at exactly this version (0 = must not exist). */
  ifVersion?: number;
}

export class CollectionRef<T = JsonObject> extends Query<T> {
  doc(id: string): DocumentRef<T> {
    return new DocumentRef<T>(this.store, this.collection, id);
  }

  /** Create a document with a generated, time-sortable id (or `opts.id`). */
  async add(data: T, opts: { id?: string } = {}): Promise<DocumentSnapshot<T>> {
    const r = await this.store.http.request<WriteResultBody>('POST', `/collections/${enc(this.collection)}/docs`, { id: opts.id, data });
    return new DocumentSnapshot<T>(this.doc(r.id), (r.doc as DocData<T>) ?? null);
  }
}

export class DocumentRef<T = JsonObject> {
  constructor(
    private readonly store: DocStore,
    readonly collection: string,
    readonly id: string,
  ) {}

  get path(): string {
    return `${this.collection}/${this.id}`;
  }

  private get url(): string {
    return `/collections/${enc(this.collection)}/docs/${enc(this.id)}`;
  }

  /** Read the document. `asOf` reads it as it was then; missing → `exists === false`. */
  async get(opts: { expand?: string[]; select?: string[]; asOf?: Date | string } = {}): Promise<DocumentSnapshot<T>> {
    try {
      const d = await this.store.http.request<DocData<T>>('GET', this.url, undefined, {
        expand: opts.expand?.join(','),
        select: opts.select?.join(','),
        asOf: opts.asOf ? (typeof opts.asOf === 'string' ? opts.asOf : opts.asOf.toISOString()) : undefined,
      });
      return new DocumentSnapshot<T>(this, d);
    } catch (e) {
      if (e instanceof DocStoreError && e.code === 'not_found') return new DocumentSnapshot<T>(this, null);
      throw e;
    }
  }

  /** Create or replace (or deep-merge with `{ merge: true }`). */
  async set(data: T, opts: SetOptions = {}): Promise<DocumentSnapshot<T>> {
    const r = await this.store.http.request<WriteResultBody>('PUT', this.url, {
      data,
      merge: opts.merge,
      precondition: opts.ifVersion !== undefined ? { version: opts.ifVersion } : undefined,
    });
    return new DocumentSnapshot<T>(this, (r.doc as DocData<T>) ?? null);
  }

  /** Partial update with field values: `{ views: increment(1), tags: arrayUnion('x') }`. */
  async update(update: Partial<Record<keyof T & string, unknown>> | JsonObject, opts: { ifVersion?: number; upsert?: boolean } = {}): Promise<DocumentSnapshot<T>> {
    const r = await this.store.http.request<WriteResultBody>('PATCH', this.url, {
      update: toUpdateSpec(update as JsonObject),
      upsert: opts.upsert,
      precondition: opts.ifVersion !== undefined ? { version: opts.ifVersion } : undefined,
    });
    return new DocumentSnapshot<T>(this, (r.doc as DocData<T>) ?? null);
  }

  /** Delete (idempotent). `ifVersion` guards against deleting a newer write. */
  async delete(opts: { ifVersion?: number } = {}): Promise<void> {
    await this.store.http.request('DELETE', this.url, undefined, { ifVersion: opts.ifVersion !== undefined ? String(opts.ifVersion) : undefined });
  }

  /** Every version of this document (newest first) with what changed. */
  history(opts: { limit?: number; beforeVersion?: number } = {}): Promise<{
    versions: { version: number; op: string; at: string; actor: string | null; deleted: boolean; data: T | null; changedFields: string[] }[];
    hasMore: boolean;
  }> {
    return this.store.http.request('GET', `${this.url}/history`, undefined, {
      limit: opts.limit ? String(opts.limit) : undefined,
      beforeVersion: opts.beforeVersion ? String(opts.beforeVersion) : undefined,
    });
  }

  /** Put the document back to an earlier version (written as a NEW version — undoable). */
  async restore(version: number): Promise<DocumentSnapshot<T>> {
    const r = await this.store.http.request<WriteResultBody>('POST', `${this.url}/restore`, { version });
    return new DocumentSnapshot<T>(this, (r.doc as DocData<T>) ?? null);
  }

  /** Live document: called now and on every change (`exists === false` once deleted). */
  onSnapshot(next: (s: DocumentSnapshot<T>) => void, error?: (e: DocStoreError) => void): () => void {
    return this.store.live().subscribe(
      { collection: this.collection, kind: 'doc', id: this.id },
      {
        onSnapshot: (ack) => next(new DocumentSnapshot<T>(this, (ack.doc as DocData<T>) ?? null)),
        onDoc: (d) => next(new DocumentSnapshot<T>(this, (d as DocData<T>) ?? null)),
        onError: (code, message) => error?.(new DocStoreError(message, code, 0)),
      },
    );
  }
}

// ── batches & transactions ─────────────────────────────────────────────────

interface Op {
  type: 'create' | 'set' | 'update' | 'delete';
  collection: string;
  id?: string;
  data?: unknown;
  update?: JsonObject;
  merge?: boolean;
  precondition?: { version?: number; exists?: boolean };
}

/** Up to 500 writes committed atomically: all apply, or none do. */
export class WriteBatch {
  protected readonly ops: Op[] = [];
  constructor(protected readonly store: DocStore) {}

  create<T>(ref: DocumentRef<T>, data: T): this {
    this.ops.push({ type: 'create', collection: ref.collection, id: ref.id, data });
    return this;
  }
  set<T>(ref: DocumentRef<T>, data: T, opts: SetOptions = {}): this {
    this.ops.push({ type: 'set', collection: ref.collection, id: ref.id, data, merge: opts.merge, precondition: opts.ifVersion !== undefined ? { version: opts.ifVersion } : undefined });
    return this;
  }
  update<T>(ref: DocumentRef<T>, update: JsonObject, opts: { ifVersion?: number } = {}): this {
    this.ops.push({ type: 'update', collection: ref.collection, id: ref.id, update: toUpdateSpec(update), precondition: opts.ifVersion !== undefined ? { version: opts.ifVersion } : undefined });
    return this;
  }
  delete<T>(ref: DocumentRef<T>, opts: { ifVersion?: number } = {}): this {
    this.ops.push({ type: 'delete', collection: ref.collection, id: ref.id, precondition: opts.ifVersion !== undefined ? { version: opts.ifVersion } : undefined });
    return this;
  }

  async commit(): Promise<WriteResultBody[]> {
    if (!this.ops.length) return [];
    const r = await this.store.http.request<{ results: WriteResultBody[] }>('POST', '/commit', { operations: this.ops });
    return r.results;
  }
}

/** A read-modify-write transaction. Reads record each document's version;
 *  every write is guarded by it, so a concurrent change aborts the commit and
 *  `runTransaction` retries the whole function. */
export class Transaction extends WriteBatch {
  private readonly seen = new Map<string, number>();

  async get<T>(ref: DocumentRef<T>): Promise<DocumentSnapshot<T>> {
    const snap = await ref.get();
    this.seen.set(ref.path, snap.version);
    return snap;
  }

  /** Writes to documents read in this transaction carry their read version. */
  override async commit(): Promise<WriteResultBody[]> {
    for (const op of this.ops) {
      const v = this.seen.get(`${op.collection}/${op.id}`);
      if (v !== undefined && !op.precondition) op.precondition = { version: v };
      // A create in a transaction must not clobber a doc someone made meanwhile.
      if (op.type === 'create' && !op.precondition) op.precondition = { exists: false };
    }
    return super.commit();
  }
}

// ── the client ─────────────────────────────────────────────────────────────

export class DocStore {
  private liveClient: DocStoreLive | null = null;

  constructor(
    readonly http: DocStoreHttp,
    private readonly liveFactory: () => DocStoreLive,
  ) {}

  collection<T = JsonObject>(name: string): CollectionRef<T> {
    return new CollectionRef<T>(this, name);
  }

  /** `doc('posts/p1')` shorthand. */
  doc<T = JsonObject>(path: string): DocumentRef<T> {
    const [collection, id] = path.split('/');
    if (!collection || !id) throw new DocStoreError(`'${path}' is not a <collection>/<id> path`, 'bad_request', 400);
    return this.collection<T>(collection).doc(id);
  }

  batch(): WriteBatch {
    return new WriteBatch(this);
  }

  /** Run `fn` in an optimistic transaction, retrying (up to `maxAttempts`)
   *  when another write got there first. Return value of `fn` is passed through. */
  async runTransaction<R>(fn: (tx: Transaction) => Promise<R>, opts: { maxAttempts?: number } = {}): Promise<R> {
    const max = opts.maxAttempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      const tx = new Transaction(this);
      const result = await fn(tx);
      try {
        await tx.commit();
        return result;
      } catch (e) {
        if (!(e instanceof DocStoreError) || !e.isPreconditionFailed || attempt >= max) throw e;
        await new Promise((r) => setTimeout(r, Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random())));
      }
    }
  }

  /** Durable change stream (service key only): every committed change after `since`. */
  changes(opts: { since?: number; collections?: string[]; limit?: number } = {}): Promise<{
    changes: { seq: number; collection: string; id: string; op: string; version: number; data: JsonObject | null; actor: string | null; txId: string | null; at: string }[];
    next: number;
    hasMore: boolean;
  }> {
    return this.http.request('GET', '/changes', undefined, {
      since: String(opts.since ?? 0),
      collections: opts.collections?.join(','),
      limit: opts.limit ? String(opts.limit) : undefined,
    });
  }

  /** Server-side: deploy a collection's configuration (rules, schema, relations…) as code. */
  deployCollection(name: string, config: JsonObject): Promise<JsonObject> {
    return this.http.request('PUT', `/collections/${enc(name)}`, config);
  }

  /** The shared live connection (opened on first use). */
  live(): DocStoreLive {
    this.liveClient ??= this.liveFactory();
    return this.liveClient;
  }

  /** Close the live connection. */
  close(): void {
    this.liveClient?.close();
    this.liveClient = null;
  }
}

const enc = encodeURIComponent;
export type { SortKey };
