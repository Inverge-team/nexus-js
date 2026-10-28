# @inverge/nexus — JavaScript / TypeScript SDK

One SDK for the **Inverge Nexus** platform, correlated to a single user journey.
**Isomorphic**: the same package runs in the browser (React, Vue, Angular,
Svelte, SolidJS, vanilla JS) and on the server (Node, Express, Fastify, Nest,
serverless). Ships **ESM + CommonJS + TypeScript types**, with zero required
runtime dependencies.

- npm: `@inverge/nexus`
- Entry points: `@inverge/nexus`, `@inverge/nexus/react`, `@inverge/nexus/telescope` (Node only)
- Node `>= 18` · any modern browser

## Documentation

Installation, configuration, framework guides and the full API reference live
on the documentation site:

- **Guide** — <https://docs.inverge.net/sdks/javascript>
- **API reference** — <https://docs.inverge.net/sdks/javascript/reference>

## What it covers

- **[Sessions & identity](https://docs.inverge.net/sdks/javascript/reference/sessions)** — journey sessions and user identity shared by every product.
- **[Events](https://docs.inverge.net/sdks/javascript/reference/events)** — product analytics from the browser or the server.
- **[Logs](https://docs.inverge.net/sdks/javascript/reference/logs)** — structured, leveled logs, batched and searchable in the console.
- **[Errors](https://docs.inverge.net/sdks/javascript/reference/errors)** — uncaught errors and rejections, with context and the user's journey.
- **[Feature flags](https://docs.inverge.net/sdks/javascript/reference/flags)** — evaluate flags per user and roll features out gradually.
- **[Remote Config](https://docs.inverge.net/sdks/javascript/reference/remote-config)** — change values remotely, with targeting and live updates.
- **[Realtime](https://docs.inverge.net/sdks/javascript/reference/realtime)** — join rooms and exchange messages live.
- **[Deep links & attribution](https://docs.inverge.net/sdks/javascript/reference/links)** — resolve Nexus links and attribute visits.
- **[Surveys](https://docs.inverge.net/sdks/javascript/reference/surveys)** — in-product surveys.
- **[Push notifications](https://docs.inverge.net/sdks/javascript/reference/push)** — send transactional push to users or segments.
- **[In-app messages](https://docs.inverge.net/sdks/javascript/reference/inapp)** — banners, modals and cards designed in the console.
- **[Live Activities](https://docs.inverge.net/sdks/javascript/reference/live-activities)** — start and update Live Activities from your server.
- **[Session replay](https://docs.inverge.net/sdks/javascript/reference/replay)** — opt-in visual replay of browser sessions, with redaction.
- **[Shield](https://docs.inverge.net/products/shield/web)** — app and device integrity checks for requests to your backend.
- **[Telescope](https://docs.inverge.net/products/telescope/node)** (Node) — request-journey tracing: requests, outgoing calls, queries,
  logs and exceptions on one timeline, with N+1, duplicate and slow queries flagged.
- **[DocStore](https://docs.inverge.net/sdks/javascript/reference/docstore)** — the document database (`@inverge/nexus/docstore`): queries, live queries and aggregates, offline-first sync.

## Links

- Console — <https://nexus.inverge.net>
- Site — <https://inverge.net>
- Source — <https://github.com/Inverge-team/nexus-js>

MIT licensed. © Inverge.
