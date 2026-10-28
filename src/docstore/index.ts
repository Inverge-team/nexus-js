/**
 * `@inverge/nexus/docstore` — Nexus DocStore, the document database.
 *
 *     import { createDocStore, increment, where, or } from '@inverge/nexus/docstore';
 *
 *     const db = createDocStore({ apiKey, getToken: () => auth.currentUser?.getIdToken() ?? null });
 *     const open = await db.collection('orders').where('status', '==', 'open').orderBy('total', 'desc').limit(20).get();
 *     await db.doc('posts/p1').update({ views: increment(1) });
 *     const stop = db.collection('posts').where('published', '==', true).onSnapshot(({ docs, changes }) => …);
 *
 *     const offline = db.offline({ collections: ['todos'] });   // local-first, syncs in the background
 *     await offline.collection('todos').add({ title: 'Buy milk', done: false });
 *
 * Also reachable from the main client as `nexus.docstore({ getToken })`.
 */
import { DocStore } from './api';
import { DocStoreHttp, type DocStoreOptions } from './client';
import { DocStoreLive } from './live';
import { type OfflineOptions, OfflineStore } from './offline';

/** DocStore with its offline (local-first) mode. */
export class NexusDocStore extends DocStore {
  /** Local-first replica of `collections`: instant reads/writes that work offline,
   *  synced in the background with field-level merge. */
  offline(opts: OfflineOptions): OfflineStore {
    return new OfflineStore(this, opts);
  }
}

export function createDocStore(opts: DocStoreOptions, enabled: () => boolean = () => true): NexusDocStore {
  if (!opts.apiKey) throw new Error('createDocStore: apiKey is required');
  const http = new DocStoreHttp(opts, enabled);
  return new NexusDocStore(http, () => new DocStoreLive(opts));
}

export {
  and,
  arrayPush,
  arrayRemove,
  arrayUnion,
  avg,
  CollectionRef,
  count,
  countDistinct,
  deleteField,
  DocStore,
  DocumentRef,
  DocumentSnapshot,
  increment,
  max,
  maximum,
  mergeField,
  min,
  minimum,
  multiply,
  not,
  or,
  Query,
  serverTimestamp,
  sum,
  toUpdateSpec,
  Transaction,
  where,
  whereRelated,
  WriteBatch,
  type AggregateResult,
  type Aggregations,
  type FieldValue,
  type LiveQuerySnapshot,
  type QuerySnapshot,
  type SetOptions,
  type WhereOp,
} from './api';
export { DocStoreError, type DocData, type DocStoreOptions } from './client';
export { LocalQueryError, type Filter, type JsonObject, type SortKey } from './core';
export { DocStoreLive, type LiveStatus } from './live';
export {
  indexedDbStorage,
  LocalCollection,
  LocalDocumentRef,
  LocalQuery,
  memoryStorage,
  OfflineStore,
  type LocalSnapshot,
  type OfflineConflict,
  type OfflineOptions,
  type OfflineStorage,
  type SyncStatus,
} from './offline';
