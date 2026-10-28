/**
 * Per-service on/off switches — turn a Nexus product off without removing the
 * code that uses it. A switched-off service makes no network call and never
 * throws: writes are skipped and reads return their neutral value (flags →
 * defaults, Remote Config → defaults, lists → empty).
 *
 * Node reads the environment (all default to on):
 *
 *     NEXUS_ENABLED=false                  # everything off
 *     NEXUS_PUSH_ENABLED=false             # only push off
 *     NEXUS_LIVE_ACTIVITIES_ENABLED=false  # only Live Activities off
 *
 * In the browser (no environment) pass `services: { push: false }` /
 * `enabled: false` to `Nexus.init`. Off wins: a service is on only if neither
 * the config nor the environment turns it off.
 */

export type NexusService =
  | 'realtime'
  | 'events'
  | 'errors'
  | 'logs'
  | 'sessions'
  | 'flags'
  | 'remoteConfig'
  | 'links'
  | 'surveys'
  | 'push'
  | 'inApp'
  | 'liveActivities'
  | 'replay'
  | 'telescope'
  | 'shield'
  | 'docstore';

/** Service → the environment variable that switches it. */
export const SERVICE_ENV: Readonly<Record<NexusService, string>> = {
  realtime: 'NEXUS_REALTIME_ENABLED',
  events: 'NEXUS_EVENTS_ENABLED',
  errors: 'NEXUS_ERRORS_ENABLED',
  logs: 'NEXUS_LOGS_ENABLED',
  sessions: 'NEXUS_SESSIONS_ENABLED',
  flags: 'NEXUS_FLAGS_ENABLED',
  remoteConfig: 'NEXUS_REMOTE_CONFIG_ENABLED',
  links: 'NEXUS_LINKS_ENABLED',
  surveys: 'NEXUS_SURVEYS_ENABLED',
  push: 'NEXUS_PUSH_ENABLED',
  inApp: 'NEXUS_IN_APP_ENABLED',
  liveActivities: 'NEXUS_LIVE_ACTIVITIES_ENABLED',
  replay: 'NEXUS_REPLAY_ENABLED',
  telescope: 'NEXUS_TELESCOPE_ENABLED',
  shield: 'NEXUS_SHIELD_ENABLED',
  docstore: 'NEXUS_DOCSTORE_ENABLED',
};

/** The master switch. */
export const ALL_ENV = 'NEXUS_ENABLED';

const SERVICES = Object.keys(SERVICE_ENV) as NexusService[];

/** `/partner/<segment>` → service. */
const PATHS: Record<string, NexusService> = {
  rooms: 'realtime',
  events: 'events',
  errors: 'errors',
  logs: 'logs',
  sessions: 'sessions',
  flags: 'flags',
  'remote-config': 'remoteConfig',
  links: 'links',
  surveys: 'surveys',
  push: 'push',
  inapp: 'inApp',
  'live-activities': 'liveActivities',
  replay: 'replay',
  telescope: 'telescope',
  shield: 'shield',
  docstore: 'docstore',
};

/** The service a `/partner/...` path belongs to, or null for unswitched paths. */
export function serviceForPath(path: string): NexusService | null {
  const segment = path.replace(/^\/?partner\//, '').split('/')[0] ?? '';
  return PATHS[segment] ?? null;
}

/** `false` / `0` / `off` / `no` = off; anything else, or unset, = on. */
export function isOn(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

/** The process environment on Node; empty in browsers (never throws). */
function processEnv(): Record<string, string | undefined> {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return p?.env ?? {};
  } catch {
    return {};
  }
}

export interface ResolvedSwitches {
  /** Effective state per service. */
  enabled: Record<NexusService, boolean>;
  /** Why each switched-off service is off (for the diagnostic log). */
  reason: Partial<Record<NexusService, string>>;
}

/**
 * Combine config + environment, off wins. Unknown keys in `services` are
 * rejected so a typo can't silently leave a service on.
 */
export function resolveSwitches(
  services: Partial<Record<NexusService, boolean>> | undefined,
  enabled: boolean | undefined,
  env: Record<string, string | undefined> = processEnv(),
): ResolvedSwitches {
  for (const key of Object.keys(services ?? {})) {
    if (!(key in SERVICE_ENV)) {
      throw new Error(`Nexus: unknown service "${key}" in config.services. Known: ${SERVICES.join(', ')}.`);
    }
  }
  const out = {} as Record<NexusService, boolean>;
  const reason: Partial<Record<NexusService, string>> = {};
  const allOff = enabled === false ? 'config.enabled=false' : !isOn(env[ALL_ENV]) ? `${ALL_ENV}=false` : null;
  for (const s of SERVICES) {
    if (allOff) {
      out[s] = false;
      reason[s] = allOff;
    } else if (services?.[s] === false) {
      out[s] = false;
      reason[s] = `config.services.${s}=false`;
    } else if (!isOn(env[SERVICE_ENV[s]])) {
      out[s] = false;
      reason[s] = `${SERVICE_ENV[s]}=false`;
    } else {
      out[s] = true;
    }
  }
  return { enabled: out, reason };
}
