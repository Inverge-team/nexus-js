import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';
import { isBrowser, randomId } from '../environment';
import { NexusLog } from '../logging';

/** A single rrweb event ({ type, timestamp, data }). */
interface RrwebEvent {
  type: number;
  timestamp: number;
  data: unknown;
}
type StopFn = () => void;

const CHUNK_MAX = 200;

/**
 * Browser session replay. Records the DOM with **rrweb** and ships the events
 * to `/partner/replay`, correlated to the journey session — rendered natively by
 * the Nexus console's player. Requires the optional `rrweb` peer dependency.
 * No-op on the server.
 *
 * Redaction: every input is masked by default ({@link NexusConfig.replayMaskAllInputs});
 * add the `nexus-block` class to fully block an element, or `nexus-mask` to mask
 * its text (configurable via `replayBlockClass` / `replayMaskTextClass`).
 */
export class NexusReplay {
  private stopFn: StopFn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer: RrwebEvent[] = [];
  private recordingId = '';
  private href?: string;
  private width?: number;
  private height?: number;
  private recording = false;

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {}

  get isRecording(): boolean {
    return this.recording;
  }

  /** Start recording (idempotent). No-op outside the browser or without rrweb. */
  async start(): Promise<void> {
    if (!isBrowser || this.recording) return;
    let record: typeof import('rrweb').record;
    try {
      ({ record } = await import('rrweb'));
    } catch {
      NexusLog.error('replay: install `rrweb` to record session replay');
      return;
    }
    this.recordingId = randomId('rec');
    this.recording = true;
    const stop = record({
      emit: (event) => this.onEvent(event as unknown as RrwebEvent),
      maskAllInputs: this.cfg.replayMaskAllInputs,
      blockClass: this.cfg.replayBlockClass,
      maskTextClass: this.cfg.replayMaskTextClass,
      recordCanvas: false,
      collectFonts: false,
    });
    this.stopFn = stop ?? null;
    this.timer = setInterval(() => void this.flush(), this.cfg.replayFlushIntervalMs);
    NexusLog.info('session replay recording');
  }

  private onEvent(event: RrwebEvent): void {
    // The Meta event (type 4) carries the page href + viewport size.
    if (event.type === 4 && event.data && typeof event.data === 'object') {
      const d = event.data as { href?: string; width?: number; height?: number };
      if (d.href) this.href = d.href;
      if (d.width) this.width = d.width;
      if (d.height) this.height = d.height;
    }
    this.buffer.push(event);
    if (this.buffer.length >= CHUNK_MAX) void this.flush();
  }

  /** Ship any buffered events now. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    await this.http.post('/partner/replay', {
      recordingId: this.recordingId,
      events,
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      sessionKey: this.id.sessionKey,
      deviceKey: this.id.deviceKey,
      ...(this.href ? { href: this.href } : {}),
      ...(this.width ? { width: this.width } : {}),
      ...(this.height ? { height: this.height } : {}),
      ...this.id.wireContext,
    });
  }

  /** Stop recording and flush the remaining events. */
  async stop(): Promise<void> {
    this.stopFn?.();
    this.stopFn = null;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.recording = false;
    await this.flush();
  }

  dispose(): void {
    this.stopFn?.();
    this.stopFn = null;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.recording = false;
    this.buffer = [];
  }
}
