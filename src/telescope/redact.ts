/** Keys whose values never leave the process (matched case-insensitively; any
 *  key containing "password" or "secret" too). The server redacts again. */
export const DEFAULT_REDACT_KEYS = [
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-csrf-token', 'x-xsrf-token',
  'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'client_secret', 'private_key',
  'credit_card', 'card_number', 'cvv', 'cvc', 'ssn',
];

export const REDACTED = '********';

export class Redactor {
  private readonly keys: Set<string>;

  constructor(extra: string[] = []) {
    this.keys = new Set([...DEFAULT_REDACT_KEYS, ...extra].map((k) => k.toLowerCase()));
  }

  redact<T extends Record<string, unknown>>(value: T, depth = 0): T {
    return this.walk(value, depth) as T;
  }

  private walk(v: unknown, depth: number): unknown {
    if (depth > 10 || v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => this.walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      out[k] = this.keys.has(lk) || lk.includes('password') || lk.includes('secret')
        ? x == null || x === '' ? x : REDACTED
        : this.walk(x, depth + 1);
    }
    return out;
  }
}

export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(value);
}
