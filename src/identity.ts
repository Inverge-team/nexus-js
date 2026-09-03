import { loadPersisted, platformName, randomId, savePersisted } from './environment';

const DEVICE_KEY_STORE = 'nexus_device_key';

/** Shared journey identity stamped on every service's telemetry. */
export class NexusIdentity {
  distinctId: string | null = null;
  sessionKey: string;
  deviceKey: string;
  readonly traits: Record<string, unknown> = {};
  deviceContext: Record<string, unknown> = {};

  constructor() {
    this.sessionKey = randomId('sess');
    const persisted = loadPersisted(DEVICE_KEY_STORE);
    this.deviceKey = persisted ?? randomId('dev');
    if (!persisted) savePersisted(DEVICE_KEY_STORE, this.deviceKey);
    this.deviceContext = { osType: platformName() };
  }

  rotateSession(): void {
    this.sessionKey = randomId('sess');
  }

  reset(): void {
    this.distinctId = null;
    for (const k of Object.keys(this.traits)) delete this.traits[k];
    this.rotateSession();
  }

  /** Whitelisted device fields the partner ingestion endpoints accept. */
  get wireContext(): Record<string, unknown> {
    const allowed = ['osType', 'osVersion', 'appVersion', 'browser'];
    const out: Record<string, unknown> = {};
    for (const k of allowed) {
      const v = this.deviceContext[k];
      if (v != null) out[k] = v;
    }
    return out;
  }
}
