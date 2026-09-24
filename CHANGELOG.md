# Changelog

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
