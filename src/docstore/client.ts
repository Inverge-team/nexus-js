import type { Filter, JsonObject, SortKey } from './core';

/** Thrown by every DocStore call that fails. Unlike telemetry services,
 *  a database must tell you WHY a read or write failed. */
export class DocStoreError extends Error {
  constructor(
    message: string,
    /** Server code: `permission_denied`, `not_found`, `conflict`, `validation_failed`,
     *  `unauthorized`, `billing_suspended`, … or `network` / `service_disabled`. */
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DocStoreError';
  }

  /** A precondition (expected version) did not hold — someone else wrote first. */
  get isPreconditionFailed(): boolean {
    return this.code === 'conflict' && (this.details as { reason?: string } | undefined)?.reason === 'precondition_failed';
  }
}

export interface DocStoreOptions {
  apiKey: string;
  /** API origin. Default `https://services.inverge.net`. */
  baseUrl?: string;
  /** Socket.IO origin for live queries. Defaults to {@link baseUrl}. */
  realtimeUrl?: string;
  /**
   * The signed-in end user's token (from your identity provider: Firebase Auth,
   * Auth0, Cognito, Clerk, your own server…). Called before requests; return
   * null when signed out (= anonymous). `forceRefresh` is set after a 401.
   */
  getToken?: (opts: { forceRefresh: boolean }) => Promise<string | null> | string | null;
  /** SERVER-SIDE ONLY: a Databases service key — bypasses security rules. */
  serviceKey?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DocData<T = JsonObject> {
  id: string;
  data: T;
  version: number;
  createdAt: string;
  updatedAt: string;
  expand?: Record<string, unknown>;
}

export interface QueryBody {
  filter?: Filter;
  search?: string;
  sort?: SortKey[];
  limit?: number;
  cursor?: string;
  offset?: number;
  select?: string[];
  expand?: string[];
  asOf?: string;
  count?: boolean;
}

export interface WriteResultBody {
  index: number;
  status: 'ok' | 'noop' | 'rejected' | 'conflict' | 'error';
  collection: string;
  id: string;
  version?: number;
  deleted?: boolean;
  merged?: boolean;
  conflictId?: string;
  doc?: DocData | null;
  error?: { code: string; message: string; details?: unknown };
}

/** HTTP transport for `/partner/docstore/*`. Throws {@link DocStoreError}. */
export class DocStoreHttp {
  readonly base: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(readonly opts: DocStoreOptions, private readonly enabled: () => boolean = () => true) {
    this.base = `${(opts.baseUrl ?? 'https://services.inverge.net').replace(/\/+$/, '')}/partner/docstore`;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async token(forceRefresh = false): Promise<string | null> {
    if (!this.opts.getToken) return null;
    return (await this.opts.getToken({ forceRefresh })) ?? null;
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | string[] | undefined>): Promise<T> {
    if (!this.enabled()) throw new DocStoreError('DocStore is switched off (NEXUS_DOCSTORE_ENABLED / services.docstore)', 'service_disabled', 0);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
    }
    const url = `${this.base}${path}${qs.toString() ? `?${qs}` : ''}`;
    const send = async (forceRefresh: boolean) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey };
      if (this.opts.serviceKey) headers['x-nexus-service-key'] = this.opts.serviceKey;
      else {
        const t = await this.token(forceRefresh);
        if (t) headers.authorization = `Bearer ${t}`;
      }
      return this.fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    let res: Response;
    try {
      res = await send(false);
      // An end-user token can expire between getToken() and the request.
      if (res.status === 401 && this.opts.getToken && !this.opts.serviceKey) res = await send(true);
    } catch (e) {
      throw new DocStoreError(`DocStore request failed: ${e instanceof Error ? e.message : String(e)}`, 'network', 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new DocStoreError(err?.message ?? `DocStore ${method} ${path} → ${res.status}`, err?.code ?? `http_${res.status}`, res.status, err?.details);
    }
    return json as T;
  }
}
