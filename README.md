# @inverge/nexus — JavaScript / TypeScript SDK

One SDK for all Inverge Nexus services — **analytics, logs, error monitoring,
feature flags, remote config, realtime, deep-link attribution, and surveys**,
correlated to a single user journey.

**Isomorphic**: the same package runs in the browser (React, Vue, Angular,
Svelte, SolidJS, vanilla JS) and on the server (Node, Express, Fastify, Nest,
serverless). Ships **ESM + CommonJS + TypeScript types**, zero required runtime
dependencies.

- npm: `@inverge/nexus` · version `1.0.0`
- Node `>= 18` (uses the global `fetch`) · any modern browser

---

## Table of contents

1. [Installation](#1-installation)
2. [Quick start](#2-quick-start)
3. [Configuration](#3-configuration)
4. [Framework guides](#4-framework-guides)
5. [Identity](#5-identity)
6. [Events](#6-events)
7. [Logs](#7-logs)
8. [Errors](#8-errors)
9. [Feature flags](#9-feature-flags)
10. [Remote Config](#10-remote-config)
11. [Realtime](#11-realtime)
12. [Deep links & attribution](#12-deep-links--attribution)
13. [Surveys](#13-surveys)
14. [Session replay](#14-session-replay)
15. [Lifecycle & flushing](#15-lifecycle--flushing)

---

## 1. Installation

```bash
npm install @inverge/nexus
# optional, only if you use nexus.realtime:
npm install socket.io-client
```

TypeScript types are bundled. Works with ESM (`import`) and CommonJS (`require`).

---

## 2. Quick start

```ts
import { Nexus } from '@inverge/nexus';

const nexus = Nexus.init({
  apiKey: 'nxs_live_xxx',
  baseUrl: 'https://services.inverge.net',
  remoteConfigEnabled: true,
});

await nexus.identify('user_123', { email: 'a@b.com', traits: { plan: 'pro' } });
nexus.events.track('page_view', { path: '/pricing' });
```

Access it later with `Nexus.instance` (or the React `useNexus()` hook). Services:
`sessions`, `events`, `logs`, `errors`, `flags`, `remoteConfig`, `links`,
`realtime`, `surveys`.

---

## 3. Configuration

| Option | Type | Default | Purpose |
|---|---|---|---|
| `apiKey` | `string` | — | Tenant API key (`nxs_…`). |
| `baseUrl` | `string` | `https://services.inverge.net` | API origin. |
| `realtimeUrl` | `string` | `baseUrl` | Socket.IO origin, if different. |
| `autoTrackSessions` | `boolean` | `true` | Start/refresh a session automatically. |
| `autoCaptureErrors` | `boolean` | `true` | Report uncaught errors (browser + Node). |
| `flushOnHide` | `boolean` | `true` | Flush on page hide / process exit. |
| `flushIntervalMs` | `number` | `10000` | Batch flush cadence for events/logs. |
| `maxBatch` | `number` | `50` | Max items per flush. |
| `logLevel` | `'silent'\|'error'\|'warn'\|'info'\|'debug'` | `warn` | SDK diagnostics. |
| `appVersion` | `string` | — | Version reported with telemetry. |
| `defaultProperties` | `object` | `{}` | Merged into every event/person context. |
| `remoteConfigEnabled` | `boolean` | `false` | Fetch Remote Config at init. |
| `remoteConfigRealtime` | `boolean` | `false` | Re-fetch on publish (needs realtime). |
| `remoteConfigDefaults` | `object` | `{}` | In-app default config values. |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch (e.g. Node < 18 polyfill). |

---

## 4. Framework guides

The core is framework-agnostic — `Nexus.init(...)` once, then use the singleton
anywhere. Below are idiomatic entry points.

### React (with the `/react` adapter)

```tsx
import { NexusProvider, useNexus, useFlag, useRemoteConfig } from '@inverge/nexus/react';

function Root() {
  return (
    <NexusProvider config={{ apiKey: 'nxs_...', remoteConfigEnabled: true }}>
      <App />
    </NexusProvider>
  );
}

function App() {
  const nexus = useNexus();
  const rc = useRemoteConfig();            // re-renders when config changes
  const showBanner = useFlag('promo_banner');
  return (
    <button onClick={() => nexus.events.track('cta_click')}>
      {rc.getString('cta_label', 'Buy now')}
    </button>
  );
}
```

Hooks: `useNexus()`, `useTrackEvent()`, `useFlag(key)`, `useRemoteConfig()`,
`useRemoteConfigValue(key, fallback)`.

### Vue 3

```ts
// main.ts
import { Nexus } from '@inverge/nexus';
const nexus = Nexus.init({ apiKey: 'nxs_...' });
app.provide('nexus', nexus);           // or use it directly via Nexus.instance
```

```vue
<script setup lang="ts">
import { Nexus } from '@inverge/nexus';
Nexus.instance.events.track('component_mounted');
</script>
```

### Angular

```ts
// app.config.ts / a service
import { Nexus } from '@inverge/nexus';
export const nexus = Nexus.init({ apiKey: 'nxs_...' });

@Injectable({ providedIn: 'root' })
export class NexusService { readonly client = Nexus.instance; }
```

### Svelte / SolidJS / vanilla

```ts
import { Nexus } from '@inverge/nexus';
const nexus = Nexus.init({ apiKey: 'nxs_...' });
nexus.events.track('app_start');
```

### Node / Express / Fastify

```ts
import { Nexus } from '@inverge/nexus';
const nexus = Nexus.init({ apiKey: 'nxs_...', appVersion: process.env.APP_VERSION });

app.use((req, res, next) => {
  if (req.user) void nexus.identify(req.user.id);
  nexus.events.track('http_request', { method: req.method, path: req.path });
  next();
});

app.use((err, req, res, next) => {
  void nexus.errors.capture(err, { context: { path: req.path } });
  next(err);
});
```

Uncaught exceptions / unhandled rejections are reported automatically. Telemetry
is flushed on `SIGTERM`/`SIGINT`/`beforeExit`.

---

## 5. Identity

```ts
await nexus.identify('user_123', {
  email: 'a@b.com',
  name: 'Ada',
  traits: { plan: 'pro', governorate: 'Erbil' },
});
nexus.reset();               // on logout — forget user + new session
nexus.distinctId;            // string | null
nexus.sessionKey;            // string
```

---

## 6. Events

```ts
nexus.events.track('order_placed', { total: 42, currency: 'USD' });
await nexus.events.flush();                 // force send now
nexus.events.onTracked = (name) => {};      // hook for every tracked event
```

Buffered, batched (`maxBatch`/`flushIntervalMs`), and session-correlated.
`defaultProperties` are merged into every event.

## 7. Logs

```ts
nexus.logs.info('payment started', { source: 'checkout' });
nexus.logs.error('charge failed', { context: { code: 'declined' } });
// trace | debug | info | warn | error, or logs.log('warn', msg, opts)
await nexus.logs.flush();
```

## 8. Errors

```ts
try { risky(); }
catch (e) { await nexus.errors.capture(e, { handled: true, context: { feature: 'checkout' } }); }
```

`nexus.errors.install()` runs automatically (via `autoCaptureErrors`) to report
uncaught errors: browser `error`/`unhandledrejection`, Node
`uncaughtException`/`unhandledRejection`.

## 9. Feature flags

```ts
await nexus.flags.load({ plan: 'pro' });   // after identify / when targeting changes
nexus.flags.isEnabled('new_checkout');     // boolean
nexus.flags.variant('paywall');            // string | null
nexus.flags.payload('paywall');            // attached payload
nexus.flags.all;                            // Record<string, unknown>
```

## 10. Remote Config

Typed parameters with server-evaluated conditions (platform, version, country,
percentile, **custom attributes**).

```ts
nexus.remoteConfig.setDefaults({ welcome: 'Hi', max_items: 10 });

// Custom targeting attributes (fed to "Custom attribute" conditions):
nexus.remoteConfig.setAttribute('governorate', 'Duhok');
await nexus.remoteConfig.fetch();

nexus.remoteConfig.getString('welcome');       // string
nexus.remoteConfig.getBool('feature_on');      // boolean
nexus.remoteConfig.getNumber('max_items');     // number
nexus.remoteConfig.getJSON<Theme>('theme');    // typed JSON
nexus.remoteConfig.sourceOf('welcome');        // condition name, or null
nexus.remoteConfig.getAll();

// React to changes (returns an unsubscribe fn):
const off = nexus.remoteConfig.onChange(() => rerender());

// Realtime: re-fetch automatically when a new template is published
await nexus.realtime.connect();
await nexus.remoteConfig.subscribeRealtime(nexus.realtime);
```

Per-fetch attributes: `await nexus.remoteConfig.fetch({ plan: 'free' })`. The
server strictly validates attributes (safe keys, primitive values).

## 11. Realtime

Requires `socket.io-client` (optional peer dependency).

```ts
await nexus.realtime.connect();
await nexus.realtime.join('orders:42');
nexus.realtime.on('status', (data) => console.log(data));
await nexus.realtime.emit('orders:42', 'status', { state: 'shipped' });
await nexus.realtime.leave('orders:42');
nexus.realtime.disconnect();
nexus.realtime.isConnected;
```

## 12. Deep links & attribution

```ts
const data = await nexus.links.attribute({ type: 'install', clickId: 'abc', name: 'promo' });
// Browser convenience — reads `?link_click_id` from the URL:
const deferred = await nexus.links.handleCurrentUrl();
```

## 13. Surveys

Headless — fetch eligible surveys and render them with your own UI (any
framework), then submit answers.

```ts
const surveys = await nexus.surveys.fetch({ properties: { plan: 'pro' } });
await nexus.surveys.respond(surveys[0].id, { q1: 9, q2: 'Great' }, { completed: true });
nexus.surveys.dismiss(surveyId);
```

## 14. Session replay

Browser-only. Records the DOM with **rrweb** and ships events to the Nexus
console's player, correlated to the journey session. Requires the optional
`rrweb` peer dependency (`npm install rrweb`).

```ts
const nexus = Nexus.init({
  apiKey: 'nxs_...',
  replayEnabled: true,            // auto-starts in the browser
  replayMaskAllInputs: true,      // redact all input values (default)
  replayBlockClass: 'nexus-block',    // fully block these elements
  replayMaskTextClass: 'nexus-mask',  // mask these elements' text
});

// Manual control:
await nexus.replay.start();
await nexus.replay.stop();
nexus.replay.isRecording;
```

Redaction in your markup:

```html
<div class="nexus-block">     <!-- never captured --></div>
<span class="nexus-mask">4111 1111 1111 1111</span> <!-- text masked -->
```

On the server (Node) replay is a no-op. It's opt-in (billed / privacy-sensitive).

## 15. Lifecycle & flushing

```ts
await nexus.flush();   // flush all batched telemetry now
nexus.dispose();       // tear down (also on re-init)
```

Telemetry auto-flushes on browser page hide / tab switch and on Node process
exit signals.
