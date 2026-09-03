/** Runtime environment detection (isomorphic — browser vs Node). */
export const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

export const isNode: boolean =
  typeof process !== 'undefined' && !!process.versions?.node && !isBrowser;

/** Best-effort platform label for targeting/telemetry. */
export function platformName(): string {
  if (isBrowser) return 'web';
  if (isNode) return 'node';
  return 'unknown';
}

/** A stable-ish store for the device/install id (localStorage in the browser). */
export function loadPersisted(key: string): string | null {
  try {
    if (isBrowser && window.localStorage) return window.localStorage.getItem(key);
  } catch {
    /* private mode / disabled storage */
  }
  return null;
}

export function savePersisted(key: string, value: string): void {
  try {
    if (isBrowser && window.localStorage) window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(9);
  // Web Crypto is global in browsers and Node >= 18.
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}
