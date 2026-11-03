/**
 * Nexus Messaging for Node — send on WhatsApp, Telegram, SMS and the other
 * channels from your backend.
 *
 * ```ts
 * import { NexusMessaging } from '@inverge/nexus/messaging';
 * const messaging = new NexusMessaging({ apiKey: process.env.NEXUS_API_KEY! });
 *
 * await messaging.send({
 *   channel: 'whatsapp', to: '+9647501234567',
 *   template: 'order_shipped', language: 'en_US', variables: { order_id: 'A-91' },
 * });
 * ```
 *
 * Server-only, and a separate entry for that reason: sending spends the
 * project's wallet, so the API key must never ship in a browser bundle.
 *
 * Verification codes go out on WhatsApp first, then Telegram.
 *
 * Send-only: an API key sends messages, reads a sent message's status and
 * delivery timeline, uploads a file to attach, and runs OTP verifications.
 * Templates, numbers, senders, webhooks, campaigns and the inbox are managed in
 * the console. `content` is passed through as given — the API validates it per
 * channel (WhatsApp keys it by `kind`, Telegram by `type`).
 *
 * Unlike the telemetry services, messaging THROWS (`MessagingError`): a send
 * that failed must not look like one that worked. A switched-off service
 * (`NEXUS_MESSAGING_ENABLED=false`) makes no call and returns `null`.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { resolveSwitches } from '../switches';

export class MessagingError extends Error {
  constructor(
    message: string,
    /** Server code — e.g. `content_rejected`, `template_unavailable`,
     *  `insufficient_balance`, `no_route`, `validation_failed`, `unauthorized`,
     *  `billing_suspended` — or `network`. */
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

export interface MessagingOptions {
  apiKey: string;
  baseUrl?: string;
  /** Retries for sends and reads on a network error, 429 or 5xx. Default 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Default: the global one. */
  fetch?: typeof fetch;
}

export type Channel = 'whatsapp' | 'telegram' | 'sms' | 'messenger' | 'instagram' | (string & {});

export interface SendMessage {
  channel: Channel;
  /** E.164 for WhatsApp/SMS; a chat id or `@username` for Telegram. */
  to: string;
  /** Plain text — or the caption when `content` is media. */
  body?: string;
  /** Structured content, validated per channel. */
  content?: Record<string, unknown>;
  /** A registered sender (SMS sender ID, Telegram bot `@username`). Optional on WhatsApp. */
  sender?: string;
  /** An approved template by name (WhatsApp) or a stored template key. */
  template?: string;
  /** Template language/locale, e.g. `en_US`, `ar`. */
  language?: string;
  /** Values for the template's named variables. */
  variables?: Record<string, string | number>;
  messageClass?: 'transactional' | 'promotional' | 'otp';
  scheduledAt?: Date | string;
  validityPeriodSec?: number;
  /** Echoed back on reads and webhooks. */
  metadata?: Record<string, unknown>;
  /** Rewrite links into tracked short links (SMS and WhatsApp). */
  trackLinks?: boolean;
  /** Your end user's IP, for abuse limits. */
  clientIp?: string;
  /** Dedupe key. Generated when omitted, so a retried send never doubles. */
  idempotencyKey?: string;
}

export interface Price { amount: string; currency: string }

export interface SendResult {
  id: string;
  status: string;
  channel: string;
  segments: number;
  encoding: string;
  mode: string;
  price: Price | null;
  warnings?: string[];
}

export interface Message {
  id: string;
  channel: string;
  status: string;
  to: string;
  sender: string;
  body?: string;
  segments: number;
  messageClass: string;
  country: string | null;
  mode: string;
  price: Price | null;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  deliveredAt: string | null;
  scheduledAt: string | null;
  expiresAt: string | null;
  metadata: unknown;
  telegram?: unknown;
  [key: string]: unknown;
}

export interface MessageEvent { id: string; type: string; status: string | null; occurredAt: string; data: unknown }

export interface Upload {
  /** A path, bytes, or a Blob. */
  file: string | Uint8Array | ArrayBuffer | Blob;
  /** Media type; guessed from the filename when omitted. */
  contentType?: string;
  filename?: string;
}

export interface StartVerification {
  /** E.164. */
  to: string;
  /**
   * Channels to try, in order. Default: WhatsApp, then Telegram — the code moves
   * on when a channel refuses it or hasn't delivered it within `fallbackAfter`.
   */
  channels?: ('whatsapp' | 'telegram' | 'sms')[];
  /** WhatsApp authentication template to send (default: the platform's). */
  whatsappTemplate?: string;
  /** Its language, e.g. `en_US`, `ar`. */
  whatsappLanguage?: string;
  codeLength?: number;
  /** Seconds the code is valid. */
  ttl?: number;
  /** Also try SMS last (only where SMS is available). */
  smsFallback?: boolean;
  /** Seconds each channel gets to deliver before the next is tried. */
  fallbackAfter?: number;
  smsSender?: string;
  /** `{{code}}` is replaced. */
  smsTemplate?: string;
  senderUsername?: string;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export interface Verification {
  id: string;
  to: string;
  status: 'pending' | 'approved' | 'failed' | 'expired' | 'canceled' | (string & {});
  channel: string;
  fallback: string | null;
  fellBackAt: string | null;
  fallbackReason: string | null;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  approvedAt: string | null;
  createdAt: string;
  metadata: unknown;
}

export interface VerificationCheck extends Verification { valid: boolean; attemptsRemaining: number }

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.amr': 'audio/amr', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.csv': 'text/csv', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface Call {
  method: 'GET' | 'POST';
  path: string;
  json?: Record<string, unknown>;
  raw?: { bytes: Uint8Array; contentType: string };
  headers?: Record<string, string>;
  retry: boolean;
}

/** Drop `undefined`/`null` — the API rejects explicit nulls. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

const seg = (v: string) => encodeURIComponent(v);

/** The send body, in the API's field names. Exported for tests. */
export function messageBody(m: SendMessage): Record<string, unknown> {
  if (!m.channel) throw new TypeError("messaging.send() requires a channel, e.g. 'whatsapp' or 'telegram'.");
  if (!m.to) throw new TypeError('messaging.send() requires a recipient (to).');
  if (m.body === undefined && m.content === undefined && m.template === undefined) {
    throw new TypeError('messaging.send() needs body, content or template.');
  }
  return compact({
    channel: m.channel,
    to: m.to,
    body: m.body,
    content: m.content,
    sender: m.sender,
    templateKey: m.template,
    templateLocale: m.language,
    templateVariables: m.variables
      ? Object.fromEntries(Object.entries(m.variables).map(([k, v]) => [k, String(v)]))
      : undefined,
    messageClass: m.messageClass,
    scheduledAt: m.scheduledAt instanceof Date ? m.scheduledAt.toISOString() : m.scheduledAt,
    validityPeriodSec: m.validityPeriodSec,
    metadata: m.metadata,
    trackLinks: m.trackLinks,
    clientIp: m.clientIp,
  });
}

export class NexusMessaging {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly on: boolean;

  /** OTP codes on WhatsApp, then Telegram. */
  readonly verifications: {
    start(v: StartVerification): Promise<Verification | null>;
    check(id: string, code: string): Promise<VerificationCheck | null>;
    get(id: string): Promise<Verification | null>;
    cancel(id: string): Promise<Verification | null>;
  };

  constructor(opts: MessagingOptions) {
    if (!opts?.apiKey) throw new Error('Nexus Messaging: apiKey is required (nxs_...).');
    this.apiKey = opts.apiKey;
    this.base = (opts.baseUrl ?? process.env.NEXUS_BASE_URL ?? 'https://services.inverge.net').replace(/\/+$/, '');
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchFn = opts.fetch ?? fetch;
    this.on = resolveSwitches(undefined, undefined).enabled.messaging;

    const v = '/partner/messaging/verifications';
    this.verifications = {
      // Never retried: a repeated start sends a second code, a repeated check
      // spends one of the user's attempts.
      start: (s) => {
        if (!s?.to) throw new TypeError('verifications.start() requires a phone number in E.164 form.');
        const { smsFallback, ...rest } = s;
        return this.call({ method: 'POST', path: v, json: compact({ ...rest, fallback: smsFallback ? 'sms' : undefined }), retry: false });
      },
      check: (id, code) => this.call({ method: 'POST', path: `${v}/${seg(id)}/check`, json: { code: String(code) }, retry: false }),
      get: (id) => this.call({ method: 'GET', path: `${v}/${seg(id)}`, retry: true }),
      cancel: (id) => this.call({ method: 'POST', path: `${v}/${seg(id)}/cancel`, json: {}, retry: true }),
    };
  }

  /** Whether `NEXUS_MESSAGING_ENABLED` (or `NEXUS_ENABLED`) leaves messaging on. */
  enabled(): boolean {
    return this.on;
  }

  /**
   * Send a message. Resolves once it is queued (`status: 'queued'`); delivery
   * is asynchronous — read it back with `get()` / `events()`.
   */
  send(message: SendMessage): Promise<SendResult | null> {
    return this.call({
      method: 'POST',
      path: '/partner/messaging/messages',
      json: messageBody(message),
      // Safe to retry because the key is the same on every attempt.
      headers: { 'Idempotency-Key': message.idempotencyKey ?? `nxs-${randomUUID()}` },
      retry: true,
    });
  }

  /** A sent message's current status, price and timestamps. */
  get(id: string): Promise<Message | null> {
    return this.call({ method: 'GET', path: `/partner/messaging/messages/${seg(id)}`, retry: true });
  }

  /** The delivery timeline: queued → submitted → sent → delivered. */
  async events(id: string): Promise<MessageEvent[]> {
    const r = await this.call<{ events?: MessageEvent[] }>({ method: 'GET', path: `/partner/messaging/messages/${seg(id)}/events`, retry: true });
    return Array.isArray(r?.events) ? r.events : [];
  }

  /** Upload a file for WhatsApp; send it as `{ id: mediaId }`. */
  uploadMedia(upload: Upload): Promise<{ mediaId: string; expiresNote: string } | null> {
    return this.upload('/partner/messaging/media', upload);
  }

  /** Upload a file for Telegram; send its `uploadId` (`tgf_…`) as the media. */
  uploadTelegramFile(
    upload: Upload,
  ): Promise<{ uploadId: string; filename: string; contentType: string; size: number; expiresAt: string } | null> {
    return this.upload('/partner/messaging/telegram/uploads', upload);
  }

  private async upload<T>(path: string, u: Upload): Promise<T | null> {
    let bytes: Uint8Array;
    let filename = u.filename;
    let contentType = u.contentType;
    if (typeof u.file === 'string') {
      bytes = new Uint8Array(await readFile(u.file));
      filename ??= basename(u.file);
    } else if (u.file instanceof Uint8Array) {
      bytes = u.file;
    } else if (u.file instanceof ArrayBuffer) {
      bytes = new Uint8Array(u.file);
    } else {
      bytes = new Uint8Array(await u.file.arrayBuffer());
      contentType ??= u.file.type || undefined;
    }
    if (bytes.byteLength === 0) throw new TypeError('The file is empty.');
    contentType ??= filename ? TYPES[extname(filename).toLowerCase()] : undefined;
    if (!contentType) throw new TypeError("Pass contentType (e.g. 'image/jpeg'); it could not be guessed.");
    const q = filename ? `?filename=${encodeURIComponent(filename)}` : '';
    return this.call({ method: 'POST', path: path + q, raw: { bytes, contentType }, retry: false });
  }

  private async call<T>(c: Call): Promise<T | null> {
    if (!this.on) return null;
    const headers: Record<string, string> = { 'x-api-key': this.apiKey, accept: 'application/json', ...c.headers };
    let body: BodyInit | undefined;
    if (c.raw) {
      headers['content-type'] = c.raw.contentType;
      body = c.raw.bytes as unknown as BodyInit;
    } else if (c.json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(c.json);
    }
    const attempts = c.retry ? 1 + this.maxRetries : 1;
    let last: MessagingError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(Math.min(250 * 2 ** (attempt - 1) + Math.random() * 250, 5000));
      let res: Response;
      try {
        res = await this.fetchFn(this.base + c.path, {
          method: c.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        last = new MessagingError(`${c.method} ${c.path} failed: ${(e as Error).message}`, 'network', 0);
        continue;
      }
      const text = await res.text();
      const data = text ? safeJson(text) : null;
      if (res.ok) return data as T;
      const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      last = new MessagingError(err?.message ?? `HTTP ${res.status}`, err?.code ?? `http_${res.status}`, res.status, err?.details);
      if (!RETRY_STATUSES.has(res.status) || err?.code === 'usage_limit_exceeded') break;
    }
    throw last ?? new MessagingError(`${c.method} ${c.path} failed`, 'network', 0);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
