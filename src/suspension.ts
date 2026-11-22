/**
 * The billing-suspension circuit breaker, shared by every Nexus client in the
 * process (and, in a browser, by every page load via localStorage).
 *
 * When the API answers 402 `billing_suspended` (an overdue invoice), the SDK
 * stops calling it for the pause the API asks for (`details.retryAfterSeconds`,
 * default 5 minutes): calls made meanwhile are refused locally, with no
 * request. When the pause ends ONE request goes out as a probe (holding a short
 * lease so concurrent callers keep waiting): a 402 starts a new pause, any other
 * answer means access is back.
 *
 * Without this a suspended app keeps calling at full rate — and one that
 * reports its own failures to Nexus Errors turns every refused call into
 * another one.
 *
 * Messaging is exempt: it is paid from its own prepaid wallet and the API never
 * suspends it. Its 402 `insufficient_balance` (empty wallet) is not a suspension.
 */

import { isBrowser } from './environment';

export const DEFAULT_PAUSE_SECONDS = 300;
const MIN_SECONDS = 30;
const MAX_SECONDS = 3600;
const PROBE_LEASE_MS = 30_000;
const STORAGE_PREFIX = 'inverge-nexus:suspended:';

/** key → pause end (epoch ms). */
const pauses = new Map<string, number>();
const loaded = new Set<string>();

/** Identifies one API key on one base URL without keeping the key itself. */
export function suspensionKey(baseUrl: string, apiKey: string): string {
  // FNV-1a — only needs to tell keys apart, not to be secret-proof.
  let h = 0x811c9dc5;
  const s = `${baseUrl.replace(/\/+$/, '')}|${apiKey}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Whether `path` is billed from a prepaid wallet and so never suspended. */
export function isExempt(path: string): boolean {
  return /^\/partner\/messaging(?:[/?]|$)/.test(path);
}

/** Whether an API answer is the billing-suspension refusal. */
export function isSuspension(status: number, code: unknown): boolean {
  return status === 402 && code === 'billing_suspended';
}

/** Milliseconds the pause still has to run (0 = not paused). Read-only. */
export function pausedFor(key: string, path = ''): number {
  if (path && isExempt(path)) return 0;
  const until = read(key);
  return until === undefined ? 0 : Math.max(0, until - Date.now());
}

/**
 * Before a request: true to send it, false to refuse it locally. When a pause
 * has just ended, the caller becomes the probe and the others keep waiting.
 */
export function beginRequest(key: string, path: string): boolean {
  if (isExempt(path)) return true;
  const until = read(key);
  if (until === undefined) return true;
  const now = Date.now();
  if (until > now) return false;
  write(key, now + PROBE_LEASE_MS);
  return true;
}

/**
 * After an HTTP answer: a 402 `billing_suspended` starts (or extends) the pause
 * and returns its length in seconds; any other answer lifts a pause.
 */
export function recordResponse(key: string, path: string, status: number, code?: unknown, details?: unknown): number | null {
  if (isSuspension(status, code)) {
    const raw = (details as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds;
    const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_PAUSE_SECONDS));
    write(key, Date.now() + seconds * 1000);
    return seconds;
  }
  if (!isExempt(path) && pauses.has(key)) {
    pauses.delete(key);
    storage()?.removeItem(STORAGE_PREFIX + key);
  }
  return null;
}

/** Forget every pause (tests; or after settling an invoice, to retry at once). */
export function resetSuspensions(): void {
  const s = storage();
  for (const key of pauses.keys()) s?.removeItem(STORAGE_PREFIX + key);
  pauses.clear();
  loaded.clear();
}

/** The message for a call refused locally. */
export function suspendedMessage(remainingMs: number): string {
  return `API access is suspended for an overdue invoice. Nexus calls are paused for ${Math.max(1, Math.ceil(remainingMs / 1000))} more seconds; settle the outstanding balance to restore access.`;
}

function read(key: string): number | undefined {
  if (!loaded.has(key)) {
    loaded.add(key);
    const raw = storage()?.getItem(STORAGE_PREFIX + key);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && !pauses.has(key)) pauses.set(key, n);
  }
  return pauses.get(key);
}

function write(key: string, until: number): void {
  pauses.set(key, until);
  loaded.add(key);
  storage()?.setItem(STORAGE_PREFIX + key, String(until));
}

/** localStorage when there is one that works (browsers); otherwise memory only. */
function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  // Browsers only: on Node 22+ merely touching globalThis.localStorage prints
  // an ExperimentalWarning, and a server process remembers in memory anyway.
  if (!isBrowser) return null;
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    return {
      getItem: (k) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      setItem: (k, v) => {
        try {
          ls.setItem(k, v);
        } catch {
          /* full or blocked — memory still holds the pause */
        }
      },
      removeItem: (k) => {
        try {
          ls.removeItem(k);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}
