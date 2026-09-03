import * as React from 'react';
import { Nexus } from './nexus';
import type { NexusConfig } from './config';

const NexusContext = React.createContext<Nexus | null>(null);

export interface NexusProviderProps {
  /** Provide either a ready instance, or a config to init one. */
  client?: Nexus;
  config?: NexusConfig;
  children: React.ReactNode;
}

/** Provides a Nexus instance to the tree. Pass a `config` to auto-init, or a
 * `client` you created yourself. */
export function NexusProvider({ client, config, children }: NexusProviderProps): React.ReactElement {
  const instance = React.useMemo<Nexus>(() => {
    if (client) return client;
    if (config) return Nexus.isInitialized ? Nexus.instance : Nexus.init(config);
    return Nexus.instance;
  }, [client, config]);
  return <NexusContext.Provider value={instance}>{children}</NexusContext.Provider>;
}

/** The Nexus instance from context (falls back to the global singleton). */
export function useNexus(): Nexus {
  const ctx = React.useContext(NexusContext);
  return ctx ?? Nexus.instance;
}

/** Track an event with a stable callback. */
export function useTrackEvent(): (name: string, properties?: Record<string, unknown>) => void {
  const nexus = useNexus();
  return React.useCallback((name, properties) => nexus.events.track(name, properties), [nexus]);
}

/** Whether a feature flag is enabled (call `nexus.flags.load()` first). */
export function useFlag(key: string): boolean {
  const nexus = useNexus();
  return nexus.flags.isEnabled(key);
}

/** Subscribe to Remote Config; re-renders when the config changes. Returns the
 * service so you can call `getString`/`getBool`/… */
export function useRemoteConfig(): Nexus['remoteConfig'] {
  const nexus = useNexus();
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => nexus.remoteConfig.onChange(() => force()), [nexus]);
  return nexus.remoteConfig;
}

/** A single Remote Config value, re-rendered on change. */
export function useRemoteConfigValue<T = unknown>(key: string, fallback?: T): T {
  const rc = useRemoteConfig();
  return (rc.getValue(key) as T) ?? (fallback as T);
}
