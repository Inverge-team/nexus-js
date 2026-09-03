import type { Socket } from 'socket.io-client';
import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import { NexusLog } from '../logging';

export type EventHandler = (data: unknown) => void;

/** Realtime messaging over Socket.IO. Authenticated with the API key + journey
 * identity. `socket.io-client` is an optional peer dependency (loaded on demand). */
export class NexusRealtime {
  private socket: Socket | null = null;
  private readonly rooms = new Set<string>();
  private readonly handlers = new Map<string, EventHandler>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly id: NexusIdentity,
  ) {}

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Open the connection (idempotent). Rooms are re-joined after a reconnect. */
  async connect(): Promise<void> {
    if (this.socket) return;
    let io: typeof import('socket.io-client').io;
    try {
      ({ io } = await import('socket.io-client'));
    } catch {
      NexusLog.error('realtime: install `socket.io-client` to use nexus.realtime');
      return;
    }
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
    socket.on('connect', () => {
      for (const room of this.rooms) socket.emit('room.join', { name: room });
      for (const [event, handler] of this.handlers) socket.on(event, handler);
      NexusLog.info('realtime connected');
    });
    socket.on('disconnect', () => NexusLog.info('realtime disconnected'));
    this.socket = socket;
    socket.connect();
  }

  /** Join a room. Returns the server ack (`{ ok, room, related }`). */
  async join(room: string): Promise<unknown> {
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

  /** Listen for a server event. */
  on(event: string, handler: EventHandler): void {
    this.handlers.set(event, handler);
    this.socket?.on(event, handler);
  }

  /** Stop listening for a server event. */
  off(event: string): void {
    this.handlers.delete(event);
    this.socket?.off(event);
  }

  disconnect(): void {
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
