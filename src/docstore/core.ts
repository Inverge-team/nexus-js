/**
 * The pure core shared by the remote client and the offline engine: value
 * semantics, the JSON filter matcher, update operators and the hybrid logical
 * clock. These MIRROR the server (services.inverge.net
 * `modules/databases/shared/expression/values.ts`, `docstore/domain/update-ops.ts`,
 * `docstore/domain/sync.ts`) so a query evaluated against the local cache
 * returns what the server would.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = Record<string, unknown>;

// ── values ─────────────────────────────────────────────────────────────────

type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

export function typeOf(v: unknown): JsonType {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'boolean' || t === 'number' || t === 'string' ? t : 'object';
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return false;
  if (ta === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  if (ta === 'object') {
    const x = a as JsonObject;
    const y = b as JsonObject;
    const kx = Object.keys(x).filter((k) => x[k] !== undefined);
    const ky = Object.keys(y).filter((k) => y[k] !== undefined);
    return kx.length === ky.length && kx.every((k) => deepEqual(x[k], y[k]));
  }
  return false;
}

/** Type-bracketed ordering: `age > 18` is false (not an error) for a string age. */
export function compareBracketed(a: unknown, b: unknown): number | null {
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return null;
  if (ta === 'number') return (a as number) - (b as number);
  if (ta === 'string') return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  if (ta === 'boolean') return Number(a) - Number(b);
  return null;
}

const RANK: Record<JsonType, number> = { null: 0, string: 1, number: 2, boolean: 3, array: 4, object: 5 };

/** Total order for sorting — Postgres jsonb order: null < string < number < boolean < array < object. */
export function compareTotal(a: unknown, b: unknown): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return RANK[ta] - RANK[tb];
  if (ta === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return x.length - y.length;
    for (let i = 0; i < x.length; i++) {
      const c = compareTotal(x[i], y[i]);
      if (c) return c;
    }
    return 0;
  }
  if (ta === 'object') {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return compareBracketed(a, b) ?? 0;
}

export function getPath(v: unknown, path: string | string[]): unknown {
  const segs = Array.isArray(path) ? path : path.split('.');
  let cur: unknown = v;
  for (const s of segs) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      const i = Number(s);
      cur = Number.isInteger(i) ? cur[i] : null;
    } else if (typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, s) ? (cur as JsonObject)[s] : null;
    } else return null;
  }
  return cur === undefined ? null : cur;
}

const isObj = (v: unknown): v is JsonObject => typeOf(v) === 'object';
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ── filter matcher (the JSON filter, evaluated locally) ────────────────────

export type Filter = Record<string, unknown>;

export class LocalQueryError extends Error {}

function inOp(l: unknown, r: unknown): boolean {
  if (Array.isArray(r)) return r.some((v) => deepEqual(v, l));
  if (isObj(r)) return typeof l === 'string' && Object.prototype.hasOwnProperty.call(r, l);
  if (typeof r === 'string' && typeof l === 'string') return r.includes(l);
  return false;
}

/** Evaluate a JSON filter against `{ id, data }`, exactly as the server would.
 *  `$rel`, `$search` and `$expr` need the server and throw {@link LocalQueryError}. */
export function matches(filter: Filter | undefined, id: string, data: JsonObject): boolean {
  if (!filter) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      const subs = (cond as Filter[]).map((f) => matches(f, id, data));
      const ok = key === '$and' ? subs.every(Boolean) : key === '$or' ? subs.some(Boolean) : !subs.some(Boolean);
      if (!ok) return false;
      continue;
    }
    if (key === '$not') {
      if (matches(cond as Filter, id, data)) return false;
      continue;
    }
    if (key === '$search' || key === '$expr') throw new LocalQueryError(`${key} needs the server — not available on the offline cache`);
    const value = key === '$id' ? id : getPath(data, key);
    if (!fieldMatches(key, value, cond)) return false;
  }
  return true;
}

function isOperatorObject(v: unknown): v is JsonObject {
  return isObj(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
}

function fieldMatches(key: string, value: unknown, cond: unknown): boolean {
  if (!isOperatorObject(cond)) return deepEqual(value, cond);
  for (const [op, arg] of Object.entries(cond)) {
    const cmp = (f: (c: number) => boolean) => {
      const c = compareBracketed(value, arg);
      return c !== null && f(c);
    };
    let ok: boolean;
    switch (op) {
      case '$eq': ok = deepEqual(value, arg); break;
      case '$ne': ok = !deepEqual(value, arg); break;
      case '$gt': ok = cmp((c) => c > 0); break;
      case '$gte': ok = cmp((c) => c >= 0); break;
      case '$lt': ok = cmp((c) => c < 0); break;
      case '$lte': ok = cmp((c) => c <= 0); break;
      case '$in': ok = inOp(value, arg); break;
      case '$nin': ok = !inOp(value, arg); break;
      case '$between': {
        const [lo, hi] = arg as unknown[];
        const a = compareBracketed(value, lo);
        const b = compareBracketed(value, hi);
        ok = a !== null && b !== null && a >= 0 && b <= 0;
        break;
      }
      case '$exists': ok = arg ? value !== null : value === null; break;
      case '$contains': ok = inOp(arg, value); break;
      case '$containsAny': ok = Array.isArray(value) && (arg as unknown[]).some((x) => inOp(x, value)); break;
      case '$containsAll': ok = Array.isArray(value) && (arg as unknown[]).every((x) => inOp(x, value)); break;
      case '$startsWith': ok = typeof value === 'string' && value.startsWith(arg as string); break;
      case '$endsWith': ok = typeof value === 'string' && value.endsWith(arg as string); break;
      case '$regex': {
        const [pattern, flags] = Array.isArray(arg) ? (arg as string[]) : [arg as string, ''];
        ok = typeof value === 'string' && new RegExp(pattern ?? '', (flags ?? '').replace(/[^imsu]/g, '')).test(value);
        break;
      }
      case '$size': ok = (typeof value === 'string' || Array.isArray(value) ? value.length : isObj(value) ? Object.keys(value).length : 0) === arg; break;
      case '$type': ok = typeOf(value) === arg; break;
      case '$not': ok = !fieldMatches(key, value, arg); break;
      case '$rel': throw new LocalQueryError(`$rel on '${key}' needs the server — not available on the offline cache`);
      default: throw new LocalQueryError(`unknown operator '${op}' on '${key}'`);
    }
    if (!ok) return false;
  }
  return true;
}

export interface SortKey {
  field: string;
  dir?: 'asc' | 'desc';
}

/** Comparator for local sorting, with the server's `$id` tie-break. */
export function comparator(sort: SortKey[]): (a: { id: string; data: JsonObject; createdAt?: string; updatedAt?: string }, b: { id: string; data: JsonObject; createdAt?: string; updatedAt?: string }) => number {
  const keys = [...sort];
  if (!keys.some((k) => k.field === '$id')) keys.push({ field: '$id', dir: 'asc' });
  const val = (d: { id: string; data: JsonObject; createdAt?: string; updatedAt?: string }, f: string) =>
    f === '$id' ? d.id : f === '$createdAt' ? d.createdAt ?? null : f === '$updatedAt' ? d.updatedAt ?? null : getPath(d.data, f);
  return (a, b) => {
    for (const k of keys) {
      const c = compareTotal(val(a, k.field), val(b, k.field));
      if (c) return k.dir === 'desc' ? -c : c;
    }
    return 0;
  };
}

// ── update operators (applied locally for optimistic offline writes) ───────

export const UPDATE_OPERATORS = ['$set', '$unset', '$inc', '$mul', '$min', '$max', '$push', '$addToSet', '$pull', '$pop', '$rename', '$serverTime', '$merge'] as const;

export function isOperatorUpdate(body: JsonObject): boolean {
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

function setPath(obj: JsonObject, segs: string[], v: unknown): void {
  const last = segs[segs.length - 1] ?? '';
  let cur = obj;
  for (const s of segs.slice(0, -1)) {
    if (!isObj(cur[s])) cur[s] = {};
    cur = cur[s] as JsonObject;
  }
  cur[last] = v;
}

function unsetPath(obj: JsonObject, segs: string[]): void {
  let cur: unknown = obj;
  for (const s of segs.slice(0, -1)) {
    if (!isObj(cur)) return;
    cur = cur[s];
  }
  if (isObj(cur)) delete cur[segs[segs.length - 1] ?? ''];
}

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return clone(patch);
  const out: JsonObject = isObj(base) ? clone(base) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = deepMerge(out[k], v);
  }
  return out;
}

/** Apply an update body (operators, or a plain object = shallow `$set`). Returns
 *  the new document and the top-level keys it touched. Never mutates `current`. */
export function applyUpdate(current: JsonObject, body: JsonObject, now = new Date()): { data: JsonObject; touched: string[] } {
  const out = clone(current);
  const touched = new Set<string>();
  const spec = isOperatorUpdate(body) ? body : { $set: body };
  for (const [op, arg] of Object.entries(spec)) {
    if (op === '$unset' || op === '$serverTime') {
      const fields = Array.isArray(arg) ? arg : Object.keys(arg as JsonObject);
      for (const f of fields as string[]) {
        const segs = f.split('.');
        touched.add(segs[0] ?? f);
        if (op === '$unset') unsetPath(out, segs);
        else setPath(out, segs, now.toISOString());
      }
      continue;
    }
    for (const [f, v] of Object.entries(arg as JsonObject)) {
      const segs = f.split('.');
      touched.add(segs[0] ?? f);
      const cur = getPath(out, segs);
      switch (op) {
        case '$set': setPath(out, segs, clone(v)); break;
        case '$merge': setPath(out, segs, deepMerge(cur, v)); break;
        case '$inc': setPath(out, segs, (typeof cur === 'number' ? cur : 0) + (v as number)); break;
        case '$mul': setPath(out, segs, (typeof cur === 'number' ? cur : 0) * (v as number)); break;
        case '$min':
        case '$max':
          if (cur === null || (typeof cur === typeof v && (op === '$min' ? (v as number) < (cur as number) : (v as number) > (cur as number)))) setPath(out, segs, v);
          break;
        case '$push':
        case '$addToSet': {
          const arr = Array.isArray(cur) ? [...cur] : [];
          const each = isObj(v) && Array.isArray(v.$each) ? v.$each : [v];
          for (const item of each) if (op === '$push' || !arr.some((x) => deepEqual(x, item))) arr.push(clone(item));
          const slice = isObj(v) && typeof v.$slice === 'number' ? v.$slice : null;
          setPath(out, segs, slice === null ? arr : slice < 0 ? arr.slice(slice) : arr.slice(0, slice));
          break;
        }
        case '$pull': {
          const arr = Array.isArray(cur) ? cur : [];
          const remove = isObj(v) && Array.isArray(v.$in) ? v.$in : [v];
          setPath(out, segs, arr.filter((x) => !remove.some((r) => deepEqual(x, r))));
          break;
        }
        case '$pop': {
          const arr = Array.isArray(cur) ? [...cur] : [];
          if (v === -1) arr.shift();
          else arr.pop();
          setPath(out, segs, arr);
          break;
        }
        case '$rename': {
          const to = (v as string).split('.');
          touched.add(to[0] ?? (v as string));
          if (cur !== null) {
            unsetPath(out, segs);
            setPath(out, to, cur);
          }
          break;
        }
        default:
          throw new Error(`unknown update operator '${op}'`);
      }
    }
  }
  return { data: out, touched: [...touched] };
}

// ── hybrid logical clock ───────────────────────────────────────────────────

/** HLC strings `<13-digit ms>-<4-digit counter>-<node>` order lexicographically —
 *  the same format the server merges with. */
export class Hlc {
  private lastMs = 0;
  private counter = 0;

  constructor(readonly node: string) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(node)) throw new Error('HLC node id must be 1–32 of [A-Za-z0-9_-]');
  }

  now(wall = Date.now()): string {
    if (wall > this.lastMs) {
      this.lastMs = wall;
      this.counter = 0;
    } else this.counter++;
    return `${String(this.lastMs).padStart(13, '0')}-${String(this.counter % 10000).padStart(4, '0')}-${this.node}`;
  }

  /** Advance past a clock seen from elsewhere, so our next tick orders after it. */
  observe(remote: string): void {
    const ms = Number(remote.slice(0, 13));
    if (ms > this.lastMs && ms < Date.now() + 5 * 60_000) {
      this.lastMs = ms;
      this.counter = Number(remote.slice(14, 18));
    }
  }
}
