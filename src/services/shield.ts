import type { ResolvedConfig } from '../config';
import { isBrowser } from '../environment';
import type { NexusHttp } from '../http';
import { NexusLog } from '../logging';

/**
 * Nexus Shield — app & device integrity.
 *
 * **Browser:** obtains a device-bound token. The page generates a
 * NON-EXTRACTABLE ECDSA P-256 key with WebCrypto (stored in IndexedDB — the
 * private key can be used but never read, even by your own JavaScript), proves
 * it is a real browser (Cloudflare Turnstile / reCAPTCHA, as configured in the
 * console, or proof-of-work), and exchanges that for a short-lived token bound
 * to the key. Every request then carries the token plus a single-use DPoP
 * proof for that exact method + URL — so a token copied out of DevTools is
 * useless anywhere else.
 *
 * ```ts
 * const nexus = Nexus.init({ apiKey: 'nxs_…', shield: { app: 'web:checkout' } });
 * const res = await nexus.shield.fetch('/api/checkout', { method: 'POST', body });
 * ```
 *
 * **Server (Node):** verify what the app sent.
 *
 * ```ts
 * const v = await nexus.shield.verify({
 *   token: req.headers['x-nexus-shield'], proof: req.headers['dpop'],
 *   method: req.method, url: `https://${req.headers.host}${req.originalUrl}`, resource: 'checkout',
 * });
 * if (v?.decision !== 'allow') return res.status(401).end();
 * ```
 */

export interface ShieldConfig {
  /** Shield app reference: `web:<appId>` as registered in the console. Default `web:<hostname>`. */
  app?: string;
  /** Console-issued debug token (local dev / CI). Never ship it to production. */
  debugToken?: string;
  /** Obtain a token at init instead of on first use. Default `true` in browsers. */
  eager?: boolean;
}

export interface ShieldToken {
  value: string;
  expiresAt: Date;
  refreshAt: Date;
  score: number;
  level: 'strong' | 'device' | 'basic' | 'weak' | 'debug';
  deviceId: string;
}

export interface ShieldVerifyInput {
  token: string | string[] | undefined | null;
  proof?: string | string[] | undefined | null;
  method: string;
  /** Full URL of the incoming request (scheme + host + path; query ignored). */
  url: string;
  /** Action name matched against your Shield policies. Default `*`. */
  resource?: string;
  /** base64url SHA-256 of the raw request body, to check the proof's `bh`. */
  bodyHash?: string;
}

export interface ShieldVerdict {
  valid: boolean;
  decision: 'allow' | 'deny';
  mode: 'off' | 'monitor' | 'enforce' | 'none';
  reason: string | null;
  resource: string;
  policy: string | null;
  token: { score: number; level: string; providers: string[]; deviceId: string; appId: string; platform: string; expiresAt: string } | null;
}

const DB = 'nexus-shield';
const STORE = 'keys';
const KEY_ID = 'device-key-v1';
const TOKEN_LS = 'nexus_shield_token_v1';

export class NexusShield {
  private tokenValue: ShieldToken | null = null;
  private inflight: Promise<ShieldToken | null> | null = null;
  private key: { pair: CryptoKeyPair; jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; jkt: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffUntil = 0;
  private failures = 0;

  /** Called whenever a token is issued. */
  onToken?: (t: ShieldToken) => void;
  /** Called when an exchange is refused, with the backend failure code. */
  onRefused?: (failure: string) => void;

  constructor(
    private readonly http: NexusHttp,
    private readonly config: ResolvedConfig,
    private readonly options: ShieldConfig = {},
  ) {}

  /** @internal Called by Nexus.init. */
  start(): void {
    if (!isBrowser || !globalThis.crypto?.subtle) return;
    this.restore();
    if (this.options.eager !== false) void this.token();
  }

  get current(): ShieldToken | null {
    return this.tokenValue;
  }

  /** A valid token (exchanging one if needed). Null if none can be obtained now. */
  async token(force = false): Promise<ShieldToken | null> {
    if (!isBrowser || !globalThis.crypto?.subtle) return null;
    const t = this.tokenValue;
    if (!force && t && t.expiresAt.getTime() - 30_000 > Date.now()) return t;
    if (!force && Date.now() < this.backoffUntil) return t;
    if (this.inflight) return this.inflight;
    this.inflight = this.exchange(true)
      .catch((e) => {
        NexusLog.error('shield: exchange failed', e);
        return null;
      })
      .then((fresh) => fresh ?? t)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** `X-Nexus-Shield` + `DPoP` headers for one request. `{}` when unavailable — never throws. */
  async headers(input: { method: string; url: string | URL; body?: BodyInit | null }): Promise<Record<string, string>> {
    try {
      const t = await this.token();
      if (!t || !this.key) return {};
      const url = new URL(String(input.url), isBrowser ? location.href : undefined);
      const bh = typeof input.body === 'string' ? b64url(await sha256(utf8(input.body))) : undefined;
      const proof = await this.proof({ method: input.method, url, accessToken: t.value, bh });
      return { 'X-Nexus-Shield': t.value, DPoP: proof };
    } catch (e) {
      NexusLog.error('shield: could not sign request', e);
      return {};
    }
  }

  /** `fetch` with Shield headers added. Same signature as `fetch`. */
  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = init.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const extra = await this.headers({ method, url, body: init.body ?? null });
    const headers = new Headers(init.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return this.config.fetch(input, { ...init, headers });
  }

  /**
   * SERVER: verify a token + proof with Nexus (replay protection, blocked
   * devices and your policies included). Use a server-side API key. Returns
   * null if Nexus could not be reached — decide your own fail-open/closed.
   */
  async verify(input: ShieldVerifyInput): Promise<ShieldVerdict | null> {
    const one = (v: string | string[] | undefined | null) => (Array.isArray(v) ? v[0] : v) ?? undefined;
    const token = one(input.token);
    if (!token) {
      return { valid: false, decision: 'deny', mode: 'none', reason: 'token_missing', resource: input.resource ?? '*', policy: null, token: null };
    }
    const r = await this.http.post('/partner/shield/verify', {
      token,
      proof: one(input.proof),
      method: input.method,
      url: input.url,
      resource: input.resource,
      bodyHash: input.bodyHash,
    });
    return (r as ShieldVerdict | null) ?? null;
  }

  /** Forget this browser's key and token. */
  async reset(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.tokenValue = null;
    this.key = null;
    try {
      localStorage.removeItem(TOKEN_LS);
    } catch {
      /* private mode */
    }
    await idb('readwrite', (s) => s.delete(KEY_ID)).catch(() => undefined);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  // ---------------------------------------------------------------------------

  private appRef(): string {
    return this.options.app ?? `web:${isBrowser ? location.hostname : 'server'}`;
  }

  private async exchange(retry: boolean): Promise<ShieldToken | null> {
    const ch = (await this.http.post('/partner/shield/challenge', { app: this.appRef() })) as {
      challenge?: string;
      app?: { providers: string[]; webProvider: string | null; webSiteKey: string | null; powDifficulty: number } | null;
    } | null;
    if (!ch?.challenge) return this.fail('challenge_unavailable');
    if (!ch.app) NexusLog.warn(`shield: app "${this.appRef()}" is not registered (console → Shield → Apps)`);
    const key = await this.deviceKey();
    const binding = await sha256(utf8(`nexus-shield/v1\n${ch.challenge}\n${key.jkt}`));
    const providers = ch.app?.providers ?? [];

    const evidence: Record<string, unknown> = {};
    if (this.options.debugToken) {
      evidence.debug = { token: this.options.debugToken };
    } else if (ch.app?.webProvider === 'turnstile' && ch.app.webSiteKey && providers.includes('turnstile')) {
      const t = await turnstile(ch.app.webSiteKey, b64url(binding)).catch((e) => (NexusLog.warn(`shield: Turnstile failed (${e})`), null));
      if (t) evidence.turnstile = { token: t };
    } else if (ch.app?.webProvider === 'recaptcha' && ch.app.webSiteKey && providers.includes('recaptcha')) {
      const t = await recaptcha(ch.app.webSiteKey).catch((e) => (NexusLog.warn(`shield: reCAPTCHA failed (${e})`), null));
      if (t) evidence.recaptcha = { token: t };
    }
    if (!Object.keys(evidence).length && providers.includes('pow')) {
      evidence.pow = { nonce: await solvePow(binding, ch.app?.powDifficulty ?? 20) };
    }
    if (!Object.keys(evidence).length) return this.fail('no_evidence');

    const url = new URL(`${this.config.httpBase}/partner/shield/exchange`);
    const proof = await this.proof({ method: 'POST', url, nonce: ch.challenge });
    const res = await this.http.postRaw('/partner/shield/exchange', { app: this.appRef(), challenge: ch.challenge, jwk: key.jwk, evidence }, { DPoP: proof });
    if (!res) return this.fail('network');
    if (res.status !== 200) {
      const failure = (((res.body?.error as Record<string, unknown> | undefined)?.details as Record<string, unknown> | undefined)?.failure as string) ?? `http_${res.status}`;
      if (retry && failure === 'challenge_replayed') return this.exchange(false);
      this.onRefused?.(failure);
      return this.fail(failure);
    }
    const d = res.body as { token: string; expiresAt: string; refreshIn: number; score: number; level: ShieldToken['level']; deviceId: string };
    const t: ShieldToken = {
      value: d.token,
      expiresAt: new Date(d.expiresAt),
      refreshAt: new Date(Date.now() + (d.refreshIn ?? 2700) * 1000),
      score: d.score,
      level: d.level,
      deviceId: d.deviceId,
    };
    this.tokenValue = t;
    this.failures = 0;
    this.backoffUntil = 0;
    this.schedule(t);
    try {
      localStorage.setItem(TOKEN_LS, JSON.stringify({ ...t, expiresAt: t.expiresAt.toISOString(), refreshAt: t.refreshAt.toISOString() }));
    } catch {
      /* private mode */
    }
    NexusLog.info(`shield: token issued (score ${t.score}, ${t.level})`);
    this.onToken?.(t);
    return t;
  }

  private fail(reason: string): null {
    this.failures++;
    const wait = Math.min(600, 15 * 2 ** Math.min(5, this.failures - 1));
    this.backoffUntil = Date.now() + wait * 1000;
    NexusLog.warn(`shield: no token (${reason}) — retrying in ${wait}s`);
    return null;
  }

  private schedule(t: ShieldToken): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.token(true), Math.max(0, t.refreshAt.getTime() - Date.now()));
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(TOKEN_LS);
      if (!raw) return;
      const j = JSON.parse(raw) as ShieldToken & { expiresAt: string; refreshAt: string };
      const t = { ...j, expiresAt: new Date(j.expiresAt), refreshAt: new Date(j.refreshAt) };
      if (t.expiresAt.getTime() - 30_000 > Date.now()) {
        // Usable only with the key it is bound to — loaded lazily on first sign.
        void this.deviceKey().then((k) => {
          if (k) {
            this.tokenValue = t;
            this.schedule(t);
          }
        });
      }
    } catch {
      /* ignore a corrupt cache */
    }
  }

  private async deviceKey() {
    if (this.key) return this.key;
    let pair = (await idb<CryptoKeyPair | undefined>('readonly', (s) => s.get(KEY_ID)).catch(() => undefined)) ?? null;
    if (!pair) {
      // extractable:false — the private key can sign but can never be exported.
      pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
      await idb('readwrite', (s) => s.put(pair, KEY_ID)).catch(() => NexusLog.warn('shield: IndexedDB unavailable — key lasts this page only'));
    }
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: pub.x!, y: pub.y! };
    const jkt = b64url(await sha256(utf8(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`)));
    this.key = { pair, jwk, jkt };
    return this.key;
  }

  private async proof(p: { method: string; url: URL; accessToken?: string; nonce?: string; bh?: string }): Promise<string> {
    const key = await this.deviceKey();
    const enc = (o: unknown) => b64url(utf8(JSON.stringify(o)));
    const header = enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk });
    const payload = enc({
      jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
      htm: p.method.toUpperCase(),
      htu: `${p.url.origin}${p.url.pathname}`,
      iat: Math.floor(Date.now() / 1000),
      ...(p.accessToken ? { ath: b64url(await sha256(utf8(p.accessToken))) } : {}),
      ...(p.nonce ? { nonce: p.nonce } : {}),
      ...(p.bh ? { bh: p.bh } : {}),
    });
    // WebCrypto ECDSA already returns raw r‖s — exactly what JWS wants.
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, utf8(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  }
}

// ---- helpers ---------------------------------------------------------------------

/** Typed as ArrayBuffer-backed so WebCrypto's BufferSource accepts it. */
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

type TurnstileApi = { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void };

/** Invisible Turnstile run whose cData commits to the Shield binding hash. */
async function turnstile(siteKey: string, cData: string): Promise<string> {
  await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  const w = window as unknown as { turnstile?: TurnstileApi };
  for (let i = 0; i < 50 && !w.turnstile; i++) await new Promise((r) => setTimeout(r, 100));
  if (!w.turnstile) throw new Error('Turnstile did not load');
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647';
  document.body.appendChild(el);
  return new Promise((resolve, reject) => {
    const id = w.turnstile!.render(el, {
      sitekey: siteKey,
      cData,
      action: 'nexus_shield',
      appearance: 'interaction-only',
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => (w.turnstile!.remove(id), el.remove()), 0);
      },
      'error-callback': (code: string) => {
        reject(new Error(`Turnstile error ${code}`));
        el.remove();
      },
    });
  });
}

async function recaptcha(siteKey: string): Promise<string> {
  await loadScript(`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`);
  const w = window as unknown as { grecaptcha?: { ready: (f: () => void) => void; execute: (k: string, o: { action: string }) => Promise<string> } };
  for (let i = 0; i < 50 && !w.grecaptcha; i++) await new Promise((r) => setTimeout(r, 100));
  if (!w.grecaptcha) throw new Error('reCAPTCHA did not load');
  return new Promise((resolve, reject) => w.grecaptcha!.ready(() => w.grecaptcha!.execute(siteKey, { action: 'nexus_shield' }).then(resolve, reject)));
}

// Proof-of-work: synchronous SHA-256 (WebCrypto's per-call overhead makes it
// ~20x slower for millions of tiny hashes), yielding to the event loop so the
// page stays responsive.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** First 32 bits of SHA-256(msg) — enough to count leading zero bits ≤ 32. */
export function sha256Head(msg: Uint8Array): number {
  const l = msg.length;
  const nBlocks = ((l + 9 + 63) >> 6) << 4;
  const w32 = new Uint32Array(nBlocks);
  for (let i = 0; i < l; i++) w32[i >> 2]! |= msg[i]! << (24 - (i & 3) * 8);
  w32[l >> 2]! |= 0x80 << (24 - (l & 3) * 8);
  w32[nBlocks - 1] = l * 8;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let off = 0; off < nBlocks; off += 16) {
    for (let i = 0; i < 16; i++) w[i] = w32[off + i]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return h0 >>> 0;
}

export async function solvePow(binding: Uint8Array, difficulty: number): Promise<string> {
  const d = Math.min(32, difficulty);
  for (let n = 0; ; ) {
    for (const end = n + 20_000; n < end; n++) {
      const s = n.toString(36);
      const msg = new Uint8Array(binding.length + s.length);
      msg.set(binding);
      for (let i = 0; i < s.length; i++) msg[binding.length + i] = s.charCodeAt(i);
      const head = sha256Head(msg);
      if (head === 0 ? d <= 32 : Math.clz32(head) >= d) return s;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
