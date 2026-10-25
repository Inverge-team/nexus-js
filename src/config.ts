import { type NexusService, resolveSwitches } from './switches';

/** Configuration for {@link Nexus.init}. */
export interface NexusConfig {
  /** Tenant API key (`nxs_...`). Sent as `x-api-key`, and in the socket handshake. */
  apiKey: string;
  /** API origin. Partner endpoints live under `/partner`. Default `https://services.inverge.net`. */
  baseUrl?: string;
  /** Realtime (Socket.IO) origin. Defaults to {@link baseUrl}. */
  realtimeUrl?: string;
  /** Start/refresh a journey session automatically. Default `true`. */
  autoTrackSessions?: boolean;
  /** Capture uncaught errors automatically (browser `window`/`unhandledrejection`, Node `process`). Default `true`. */
  autoCaptureErrors?: boolean;
  /** Flush queued telemetry on page hide / process exit. Default `true`. */
  flushOnHide?: boolean;
  /** Batch flush cadence (ms) for events/logs. Default 10000. */
  flushIntervalMs?: number;
  /** Max items per flush. Default 50. */
  maxBatch?: number;
  /** Diagnostic verbosity. Default `warn`. */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /** App/service version reported with telemetry. */
  appVersion?: string;
  /** Properties merged into every event/person context. */
  defaultProperties?: Record<string, unknown>;
  /** Fetch Remote Config at init (and on foreground). Default `false`. */
  remoteConfigEnabled?: boolean;
  /** Re-fetch Remote Config live on publish (needs a realtime connection). Default `false`. */
  remoteConfigRealtime?: boolean;
  /** In-app default Remote Config values. */
  remoteConfigDefaults?: Record<string, unknown>;
  /** Record browser session replay (rrweb). Requires the `rrweb` peer dependency.
   * Browser-only; no-op on the server. Default `false`. */
  replayEnabled?: boolean;
  /** Redact every input value from replay. Default `true`. */
  replayMaskAllInputs?: boolean;
  /** CSS class on elements to fully block (never captured) in replay. Default `nexus-block`. */
  replayBlockClass?: string;
  /** CSS class on elements whose text is masked in replay. Default `nexus-mask`. */
  replayMaskTextClass?: string;
  /** How often (ms) buffered replay events are shipped. Default 5000. */
  replayFlushIntervalMs?: number;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof globalThis.fetch;
  /**
   * Switch products off without removing their code, e.g. `{ liveActivities: false }`.
   * On Node the `NEXUS_<SERVICE>_ENABLED` environment variables apply too — off wins.
   * A switched-off service makes no request and never throws.
   */
  services?: Partial<Record<NexusService, boolean>>;
  /** `false` switches every service off (also `NEXUS_ENABLED=false`). Default `true`. */
  enabled?: boolean;
}

export interface ResolvedConfig extends Required<Omit<NexusConfig, 'realtimeUrl' | 'appVersion' | 'fetch' | 'services' | 'enabled'>> {
  /** Effective per-service state (config + environment, off wins). */
  services: Record<NexusService, boolean>;
  /** Why each switched-off service is off. */
  servicesOffReason: Partial<Record<NexusService, string>>;
  realtimeUrl?: string;
  appVersion?: string;
  fetch: typeof globalThis.fetch;
  httpBase: string;
  socketBase: string;
}

// Replay defaults kept together for readability.
const REPLAY_BLOCK_CLASS = 'nexus-block';
const REPLAY_MASK_CLASS = 'nexus-mask';

export function resolveConfig(config: NexusConfig): ResolvedConfig {
  const baseUrl = (config.baseUrl ?? 'https://services.inverge.net').replace(/\/+$/, '');
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Nexus: no global `fetch` available — pass `fetch` in the config (Node < 18).');
  }
  const switches = resolveSwitches(config.services, config.enabled);
  return {
    services: switches.enabled,
    servicesOffReason: switches.reason,
    apiKey: config.apiKey,
    baseUrl,
    realtimeUrl: config.realtimeUrl,
    autoTrackSessions: config.autoTrackSessions ?? true,
    autoCaptureErrors: config.autoCaptureErrors ?? true,
    flushOnHide: config.flushOnHide ?? true,
    flushIntervalMs: config.flushIntervalMs ?? 10000,
    maxBatch: config.maxBatch ?? 50,
    logLevel: config.logLevel ?? 'warn',
    appVersion: config.appVersion,
    defaultProperties: config.defaultProperties ?? {},
    remoteConfigEnabled: config.remoteConfigEnabled ?? false,
    remoteConfigRealtime: config.remoteConfigRealtime ?? false,
    remoteConfigDefaults: config.remoteConfigDefaults ?? {},
    replayEnabled: config.replayEnabled ?? false,
    replayMaskAllInputs: config.replayMaskAllInputs ?? true,
    replayBlockClass: config.replayBlockClass ?? REPLAY_BLOCK_CLASS,
    replayMaskTextClass: config.replayMaskTextClass ?? REPLAY_MASK_CLASS,
    replayFlushIntervalMs: config.replayFlushIntervalMs ?? 5000,
    fetch: fetchImpl.bind(globalThis),
    httpBase: baseUrl,
    socketBase: (config.realtimeUrl ?? baseUrl).replace(/\/+$/, ''),
  };
}
