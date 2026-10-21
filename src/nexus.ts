import { type NexusConfig, type ResolvedConfig, resolveConfig } from './config';
import { NexusIdentity } from './identity';
import { NexusHttp } from './http';
import { NexusLog } from './logging';
import { isBrowser, isNode } from './environment';
import { NexusSessions, type IdentifyOptions } from './services/sessions';
import { NexusEvents } from './services/events';
import { NexusLogs } from './services/logs';
import { NexusErrors } from './services/errors';
import { NexusFlags } from './services/flags';
import { NexusLinks } from './services/links';
import { NexusRealtime } from './services/realtime';
import type { NexusService } from './switches';
import { NexusRemoteConfig } from './services/remote-config';
import { NexusSurveys } from './services/surveys';
import { NexusReplay } from './services/replay';
import { NexusPush } from './services/push';
import { NexusInApp } from './services/inapp';
import { NexusLiveActivities } from './services/live-activities';

/**
 * The Nexus umbrella SDK — one entry point for every service, correlated to a
 * single journey session. Isomorphic: works in every browser framework and in
 * Node/Express.
 *
 * ```ts
 * import { Nexus } from '@inverge/nexus';
 * const nexus = Nexus.init({ apiKey: 'nxs_...' });
 * nexus.events.track('order_placed', { total: 42 });
 * ```
 */
export class Nexus {
  private static _instance: Nexus | null = null;

  readonly config: ResolvedConfig;
  private readonly identity: NexusIdentity;
  private readonly http: NexusHttp;

  readonly sessions: NexusSessions;
  readonly events: NexusEvents;
  readonly logs: NexusLogs;
  readonly errors: NexusErrors;
  readonly flags: NexusFlags;
  readonly links: NexusLinks;
  readonly realtime: NexusRealtime;
  readonly remoteConfig: NexusRemoteConfig;
  readonly surveys: NexusSurveys;
  readonly replay: NexusReplay;
  readonly push: NexusPush;
  readonly inApp: NexusInApp;
  readonly liveActivities: NexusLiveActivities;

  private disposeHooks: Array<() => void> = [];

  private constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    NexusLog.configure(this.config.logLevel);
    NexusLog.info(`initialising — base=${this.config.httpBase}, apiKey=${NexusLog.mask(this.config.apiKey)}`);

    this.identity = new NexusIdentity();
    if (this.config.appVersion) this.identity.deviceContext['appVersion'] = this.config.appVersion;
    if (isBrowser && typeof navigator !== 'undefined') {
      this.identity.deviceContext['browser'] = navigator.userAgent;
    }
    this.http = new NexusHttp(this.config, this.identity);

    this.sessions = new NexusSessions(this.http, this.identity, this.config);
    this.events = new NexusEvents(this.http, this.identity, this.config);
    this.logs = new NexusLogs(this.http, this.identity, this.config);
    this.errors = new NexusErrors(this.http, this.identity, this.config);
    this.flags = new NexusFlags(this.http, this.identity, this.config);
    this.links = new NexusLinks(this.http, this.identity);
    this.realtime = new NexusRealtime(this.config, this.identity);
    this.remoteConfig = new NexusRemoteConfig(this.http, this.identity, this.config);
    this.surveys = new NexusSurveys(this.http, this.identity);
    this.replay = new NexusReplay(this.http, this.identity, this.config);
    this.push = new NexusPush(this.http, this.identity);
    this.inApp = new NexusInApp(this.http, this.identity);
    this.liveActivities = new NexusLiveActivities(this.http, this.identity);
  }

  /** The app-wide instance. Throws if {@link init} hasn't run. */
  static get instance(): Nexus {
    if (!Nexus._instance) throw new Error('Nexus.init() must be called before using the SDK.');
    return Nexus._instance;
  }
  static get isInitialized(): boolean {
    return Nexus._instance != null;
  }

  /** Initialise the SDK. **Idempotent:** if an instance already exists it is
   *  returned as-is — a repeated call (an SSR module re-eval, an HMR reload, a
   *  second import) will NOT tear down and reconnect the live realtime socket.
   *  Pass `{ force: true }` to deliberately dispose the current instance and
   *  start a fresh one (e.g. to switch API keys). */
  static init(config: NexusConfig, opts?: { force?: boolean }): Nexus {
    if (Nexus._instance) {
      if (!opts?.force) return Nexus._instance;
      Nexus._instance.dispose();
    }
    const n = new Nexus(config);
    n.boot();
    Nexus._instance = n;
    return n;
  }

  /** Whether a product is switched on — config `services` / `NEXUS_<SERVICE>_ENABLED`. */
  enabled(service: NexusService): boolean {
    return this.config.services[service];
  }

  private boot(): void {
    const on = this.config.services;
    // Switched-off services don't start background work (handlers, recorder, socket).
    if (this.config.autoCaptureErrors && on.errors) this.errors.install();
    if (this.config.autoTrackSessions && on.sessions) void this.sessions.track();
    if (this.config.remoteConfigEnabled && on.remoteConfig) void this.remoteConfig.fetch();
    if (this.config.replayEnabled && on.replay) void this.replay.start();
    if (this.config.remoteConfigRealtime && on.remoteConfig && on.realtime) {
      void this.realtime.connect().then(() => this.remoteConfig.subscribeRealtime(this.realtime));
    }
    this.installLifecycle();
    NexusLog.info('ready');
  }

  private installLifecycle(): void {
    if (!this.config.flushOnHide) return;
    if (isBrowser) {
      const onHide = () => {
        if (document.visibilityState === 'hidden') void this.flush();
      };
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', () => void this.flush());
      this.disposeHooks.push(() => document.removeEventListener('visibilitychange', onHide));
    } else if (isNode) {
      const onExit = () => void this.flush();
      process.once('beforeExit', onExit);
      process.once('SIGTERM', onExit);
      process.once('SIGINT', onExit);
    }
  }

  /** Identify the current end-user (shorthand for `sessions.identify`). */
  identify(distinctId: string, options?: IdentifyOptions): Promise<void> {
    return this.sessions.identify(distinctId, options);
  }

  /** Forget the current user and start a fresh session (e.g. on logout). */
  reset(): void {
    this.sessions.reset();
  }

  get distinctId(): string | null {
    return this.identity.distinctId;
  }
  get sessionKey(): string {
    return this.identity.sessionKey;
  }

  /** Flush all batched telemetry now. */
  async flush(): Promise<void> {
    await Promise.all([this.events.flush(), this.logs.flush(), this.replay.flush()]);
  }

  dispose(): void {
    for (const h of this.disposeHooks) h();
    this.disposeHooks = [];
    this.events.dispose();
    this.logs.dispose();
    this.replay.dispose();
    this.realtime.disconnect();
    if (Nexus._instance === this) Nexus._instance = null;
  }
}
