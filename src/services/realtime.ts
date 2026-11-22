import type { Socket } from 'socket.io-client';
import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import { NexusLog } from '../logging';
import { DEFAULT_PAUSE_SECONDS, pausedFor, recordResponse, suspensionKey } from '../suspension';

export type EventHandler = (data: unknown) => void;

/** Realtime messaging over Socket.IO. Authenticated with the API key + journey
 * identity. `socket.io-client` is an optional peer dependency (loaded on demand). */
export class NexusRealtime {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  /** Reconnect scheduled for when a billing-suspension pause ends. */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rooms = new Set<string>();
  // One event → many handlers. socket.io keeps listeners across reconnects, so
  // handlers are attached to the socket exactly once (see openSocket).
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly id: NexusIdentity,
  ) {}

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Open the connection. Idempotent, and safe under concurrent callers — a
   *  connection already open (or being opened) is reused, never duplicated.
   *  Rooms are re-joined after every reconnect. */
  async connect(): Promise<void> {
    if (!this.cfg.services.realtime) {
      NexusLog.info(`realtime is switched off (${this.cfg.servicesOffReason.realtime}) — not connecting`);
      return;
    }
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openSocket(): Promise<void> {
    let io: typeof import('socket.io-client').io;
    try {
      ({ io } = await import('socket.io-client'));
    } catch {
      NexusLog.error('realtime: install `socket.io-client` to use nexus.realtime');
      return;
    }
    if (this.socket) return; // another caller won the race while we awaited the import
    const socket = io(this.cfg.socketBase, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      auth: {
        key: this.cfg.apiKey,
        ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
        sessionKey: this.id.sessionKey,
        deviceKey: this.id.deviceKey,
        os: this.id.deviceContext['osType'],
        osVersion: this.id.deviceContext['osVersion'],
      },
      extraHeaders: { 'x-api-key': this.cfg.apiKey },
    });
    // Attach existing handlers ONCE. socket.io preserves listeners across
    // reconnects, so re-binding them on every 'connect' would stack duplicates.
    for (const [event, set] of this.handlers)
      for (const handler of set) socket.on(event, handler);
    socket.on('connect', () => {
      // Server room membership is lost on a reconnect — re-join. Do NOT re-bind
      // event handlers here (they persist on the socket instance).
      for (const room of this.rooms) socket.emit('room.join', { name: room });
      NexusLog.info('realtime connected');
    });
    socket.on('disconnect', () => NexusLog.info('realtime disconnected'));
    socket.on('connect_error', (err: Error & { data?: unknown }) => {
      if (err.message !== 'billing_suspended') return;
      // Paying the invoice is the only fix: stop socket.io's reconnect loop and
      // try once more when the pause ends (shared with every HTTP call).
      socket.disconnect();
      const key = suspensionKey(this.cfg.httpBase, this.cfg.apiKey);
      const seconds = recordResponse(key, '/partner/rooms', 402, 'billing_suspended', err.data) ?? DEFAULT_PAUSE_SECONDS;
      NexusLog.warn(`realtime: API access is suspended for an overdue invoice — retrying in ${seconds}s`);
      this.resumeAfter(socket, seconds * 1000);
    });
    socket.on('connect', () => recordResponse(suspensionKey(this.cfg.httpBase, this.cfg.apiKey), '/partner/rooms', 200));
    this.socket = socket;
    const wait = pausedFor(suspensionKey(this.cfg.httpBase, this.cfg.apiKey), '/partner/rooms');
    if (wait > 0) this.resumeAfter(socket, wait);
    else socket.connect();
  }

  private resumeAfter(socket: Socket, ms: number): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.socket === socket) socket.connect();
    }, ms);
    (this.resumeTimer as { unref?: () => void }).unref?.();
  }

  /** Join a room. Idempotent — a room already joined this session is not
   *  re-emitted (the reconnect handler re-joins it automatically). Returns the
   *  server ack (`{ ok, room }`), or a synthetic ack when already joined. */
  async join(room: string): Promise<unknown> {
    if (this.rooms.has(room)) return { ok: true, room, already: true };
    this.rooms.add(room);
    return this.ackEmit('room.join', { name: room });
  }

  /** Leave a room. */
  async leave(room: string): Promise<unknown> {
    this.rooms.delete(room);
    return this.ackEmit('room.leave', { name: room });
  }

  /** Emit one or more named events to a room with a payload. */
  async emit(room: string, event: string | string[], payload?: unknown): Promise<unknown> {
    return this.ackEmit('room.emit', { name: room, event, payload });
  }

  /** Listen for a server event. Multiple handlers per event are supported.
   *  Registering the SAME handler twice is a no-op (never stacks a duplicate
   *  socket listener). Returns an unsubscribe function — call it (e.g. from a
   *  component's teardown) instead of leaking a listener on every remount. */
  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set<EventHandler>();
      this.handlers.set(event, set);
    }
    if (!set.has(handler)) {
      set.add(handler);
      this.socket?.on(event, handler);
    }
    return () => this.off(event, handler);
  }

  /** Stop listening. With a handler, removes just that one; without, removes
   *  every handler for the event. */
  off(event: string, handler?: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    if (handler) {
      if (set.delete(handler)) this.socket?.off(event, handler);
      if (set.size === 0) this.handlers.delete(event);
    } else {
      for (const h of set) this.socket?.off(event, h);
      this.handlers.delete(event);
    }
  }

  disconnect(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  private async ackEmit(message: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.socket) await this.connect();
    const socket = this.socket;
    if (!socket) return null;
    return new Promise<unknown>((resolve) => {
      let done = false;
      const finish = (res: unknown) => {
        if (!done) {
          done = true;
          resolve(res);
        }
      };
      socket.emit(message, body, finish);
      setTimeout(() => finish(null), 10000);
    });
  }
}
