import type { Socket } from 'socket.io-client';

import type { DocData, DocStoreOptions } from './client';

export type LiveChange =
  | { type: 'added'; doc: DocData; index: number }
  | { type: 'modified'; doc: DocData; index: number; oldIndex: number }
  | { type: 'removed'; id: string; oldIndex: number };

export interface SubHandlers {
  /** The subscribe ack — runs again after every reconnect, so state resets from it. */
  onSnapshot?: (ack: Record<string, unknown>) => void;
  onChanges?: (changes: LiveChange[], meta: { hasMore: boolean; size: number }) => void;
  onDoc?: (doc: DocData | null) => void;
  onAggregate?: (result: unknown) => void;
  onError?: (code: string, message: string) => void;
}

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'stopped';

/**
 * One Socket.IO connection to `/docstore` for all of a client's live queries,
 * documents, aggregates and sync pokes. `socket.io-client` is an optional peer
 * dependency, loaded on first use.
 *
 * - Every subscription is re-sent after a reconnect; its `onSnapshot` runs
 *   again with the fresh state.
 * - End-user tokens expire: a fresh one (from `getToken`) is presented in place
 *   shortly before expiry; if the server still reports `token_expired`, the
 *   client refreshes and re-subscribes.
 * - A `billing_suspended` handshake stops reconnecting (instead of hammering
 *   the server every few seconds) and reports it once.
 */
export class DocStoreLive {
  private socket: Socket | null = null;
  private opening: Promise<Socket | null> | null = null;
  private readonly subs = new Map<string, { payload: Record<string, unknown>; handlers: SubHandlers }>();
  private readonly pokes = new Map<number, { collections: string[]; fn: (p: { seq: number; collections: string[] }) => void }>();
  private readonly statusFns = new Set<(s: LiveStatus) => void>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private seq = 0;
  status: LiveStatus = 'connecting';

  constructor(private readonly opts: DocStoreOptions) {}

  subscribe(payload: Record<string, unknown>, handlers: SubHandlers): () => void {
    const subId = `s${++this.seq}`;
    const sub = { payload, handlers };
    this.subs.set(subId, sub);
    void this.ensure().then((s) => {
      if (s?.connected) void this.send(s, subId, sub);
    });
    return () => {
      this.subs.delete(subId);
      if (this.socket?.connected) this.socket.emit('unsubscribe', { subId });
    };
  }

  /** Get a poke whenever one of `collections` changes (the offline engine pulls on it). */
  watch(collections: string[], fn: (p: { seq: number; collections: string[] }) => void): () => void {
    const id = ++this.seq;
    this.pokes.set(id, { collections, fn });
    void this.ensure().then(() => this.sendWatch());
    return () => {
      this.pokes.delete(id);
      this.sendWatch();
    };
  }

  onStatus(fn: (s: LiveStatus) => void): () => void {
    this.statusFns.add(fn);
    fn(this.status);
    return () => this.statusFns.delete(fn);
  }

  close(): void {
    clearTimeout(this.refreshTimer);
    this.socket?.disconnect();
    this.socket = null;
    this.subs.clear();
    this.pokes.clear();
    this.setStatus('stopped');
  }

  private async ensure(): Promise<Socket | null> {
    if (this.socket) return this.socket;
    this.opening ??= this.open().finally(() => (this.opening = null));
    return this.opening;
  }

  private async open(): Promise<Socket | null> {
    let io: typeof import('socket.io-client').io;
    try {
      ({ io } = await import('socket.io-client'));
    } catch {
      this.setStatus('stopped');
      throw new Error('DocStore live queries need the `socket.io-client` package');
    }
    if (this.socket) return this.socket;
    const base = (this.opts.realtimeUrl ?? this.opts.baseUrl ?? 'https://services.inverge.net').replace(/\/+$/, '');
    const socket = io(`${base}/docstore`, {
      transports: ['websocket', 'polling'],
      // A function: evaluated on every (re)connect, so it always sends a current token.
      auth: (cb) => {
        void this.authPayload(false).then(cb, () => cb({ key: this.opts.apiKey }));
      },
    });
    socket.on('connect', () => {
      this.setStatus('live');
      this.scheduleRefresh();
      for (const [subId, sub] of this.subs) void this.send(socket, subId, sub);
      this.sendWatch();
    });
    socket.on('disconnect', () => this.status !== 'stopped' && this.setStatus('connecting'));
    socket.on('connect_error', (err: Error & { data?: unknown }) => {
      if (err.message === 'billing_suspended') {
        // Paying the invoice is the only fix; retrying every few seconds helps nobody.
        socket.disconnect();
        this.setStatus('stopped');
        for (const s of this.subs.values()) s.handlers.onError?.('billing_suspended', 'Nexus access is suspended for unpaid invoices');
        return;
      }
      this.setStatus('offline');
    });
    socket.on('changes', (m: { subId: string; changes: LiveChange[]; hasMore: boolean; size: number }) =>
      this.subs.get(m.subId)?.handlers.onChanges?.(m.changes, { hasMore: m.hasMore, size: m.size }),
    );
    socket.on('doc', (m: { subId: string; doc: DocData | null }) => this.subs.get(m.subId)?.handlers.onDoc?.(m.doc));
    socket.on('aggregate', (m: { subId: string; result: unknown }) => this.subs.get(m.subId)?.handlers.onAggregate?.(m.result));
    socket.on('sync.poke', (p: { seq: number; collections: string[] }) => {
      for (const w of this.pokes.values()) if (p.collections.some((c) => w.collections.includes(c))) w.fn(p);
    });
    socket.on('db.error', (m: { subId?: string; code: string; message: string }) => {
      if (m.code === 'token_expired') {
        // Subscriptions were dropped server-side: re-auth, then reconnect re-sends them.
        void this.reauth(true).then(() => {
          socket.disconnect();
          socket.connect();
        });
        return;
      }
      if (m.subId) this.subs.get(m.subId)?.handlers.onError?.(m.code, m.message);
    });
    this.socket = socket;
    return socket;
  }

  private async authPayload(forceRefresh: boolean): Promise<Record<string, unknown>> {
    if (this.opts.serviceKey) return { key: this.opts.apiKey, serviceKey: this.opts.serviceKey };
    const token = this.opts.getToken ? await this.opts.getToken({ forceRefresh }) : null;
    return token ? { key: this.opts.apiKey, token } : { key: this.opts.apiKey };
  }

  private async send(socket: Socket, subId: string, sub: { payload: Record<string, unknown>; handlers: SubHandlers }): Promise<void> {
    const ack = (await socket.emitWithAck('subscribe', { ...sub.payload, subId })) as Record<string, unknown>;
    if (!this.subs.has(subId)) return;
    if (ack?.error) sub.handlers.onError?.(String(ack.error), String(ack.message ?? ack.error));
    else sub.handlers.onSnapshot?.(ack);
  }

  private sendWatch(): void {
    if (!this.socket?.connected) return;
    const all = new Set<string>();
    for (const w of this.pokes.values()) w.collections.forEach((c) => all.add(c));
    this.socket.emit('sync.watch', { collections: [...all] });
  }

  private async reauth(force: boolean): Promise<void> {
    if (!this.opts.getToken || !this.socket?.connected) return;
    const token = await this.opts.getToken({ forceRefresh: force });
    if (token) await this.socket.emitWithAck('auth', { token }).catch(() => undefined);
  }

  /** Present a fresh end-user token ~60 s before the current one expires. */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    if (!this.opts.getToken || this.opts.serviceKey) return;
    void Promise.resolve(this.opts.getToken({ forceRefresh: false })).then((t) => {
      const exp = jwtExp(t);
      if (!exp) return;
      const wait = Math.max(5_000, exp * 1000 - Date.now() - 60_000);
      this.refreshTimer = setTimeout(() => void this.reauth(true).finally(() => this.scheduleRefresh()), wait);
      (this.refreshTimer as { unref?: () => void }).unref?.();
    });
  }

  private setStatus(s: LiveStatus): void {
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }
}

function jwtExp(token: string | null): number | null {
  if (!token) return null;
  try {
    const part = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(part) : Buffer.from(part, 'base64').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}
