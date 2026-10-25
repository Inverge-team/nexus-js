# Changelog

## 1.4.0

- **Nexus Telescope (Node)** — new entry point `@inverge/nexus/telescope`
  (Node-only, so browser bundles are unaffected). `NexusTelescope.init()` records
  every request (hooks `http.Server`, so Express, Fastify, Koa, NestJS, Hapi and
  Next.js all work), outgoing `fetch` / `http` / axios / got calls with a W3C
  `traceparent` (downstream services join the trace), `console` output, and
  `pg` / `mysql2` / `ioredis` queries; `telescope.prisma()` for Prisma. Framework
  helpers `express()` / `expressErrors()` / `fastify()` / `koa()`, units of work
  `job()` / `command()` / `schedule()` + `inject()` to carry a trace into a queue,
  spans, tail sampling (failed / slow / monitored journeys always kept), and
  settings from the console. Switch off with `NEXUS_TELESCOPE_ENABLED=false`.

## 1.3.0

- **Switch services off without removing code** — `NEXUS_<SERVICE>_ENABLED=false`
  (Node) or `services: { liveActivities: false }` / `enabled: false` in the config
  (browser). A switched-off service makes no request and never throws, events/logs
  aren't buffered, and the socket / replay recorder / error handlers don't start.
  Off wins over the config. `nexus.enabled(service)`, exported `SERVICE_ENV`.

## 1.2.0

- **Live Activity templates.** `liveActivities.template(key, activityId)` starts an
  activity from a template designed in the Nexus console (or an inline design) and
  sends only data; the mobile SDKs render it on iOS + Android in each device's
  language. New data setters `step`, `etaAt`, `eta`, `value`/`values`, `canceled`,
  `done`, `data`, plus `lang` and `alert` for the start. Updates/ends send partial
  `data` that the server merges. Plain forms: `startTemplate`, `updateData`,
  `end(id, { data })`. `LiveActivityResult` gains `iosTargets` / `iosWarning`.
  The plain `activity(type, id)` contentState path is unchanged.

## 1.1.0

- **Realtime is now safe to wire from any framework without duplicating.** Fixes
  repeated init / repeated room joins / multiplying event callbacks — the classic
  symptoms of calling into the SDK from component mounts, SSR + client, or HMR.
  - `Nexus.init()` is **idempotent**: if an instance already exists it is returned
    unchanged instead of disposing and reconnecting the live socket. Pass
    `Nexus.init(config, { force: true })` to deliberately re-init (e.g. new API key).
  - `realtime.join(room)` is **idempotent** — a room already joined this session is
    not re-emitted (the reconnect handler still re-joins it automatically).
  - `realtime.on(event, handler)` now **returns an unsubscribe function**, supports
    **multiple handlers per event**, and **never stacks a duplicate** for the same
    handler. Reconnects no longer re-bind (and thus multiply) listeners.
    `off(event, handler?)` removes one handler or all for the event.
  - `realtime.connect()` is safe under **concurrent callers** — overlapping calls
    share a single connection attempt instead of opening two sockets.

## 1.0.0

- Initial release. Isomorphic JavaScript/TypeScript SDK for the Inverge Nexus
  platform: sessions, events, logs, errors, feature flags, remote config,
  links, realtime, surveys, and browser session replay (rrweb). Works in every browser framework and in
  Node/Express. Ships ESM + CJS + TypeScript types, plus a `/react` adapter.
