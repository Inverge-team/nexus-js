# Releasing

Publishing is automated. **Merging `dev` into `main` publishes whatever version
`package.json` declares.** Nothing is published from `dev`, and nothing is
published by hand.

## One-time setup

The workflow uses npm **Trusted Publishing** (OIDC) — there is no `NPM_TOKEN` to
create, store or rotate, and every version is published with a provenance
attestation linking it to the commit and workflow run that built it.

1. **Add the trusted publisher** — npmjs.com → `@inverge/nexus` → **Settings** →
   *Trusted Publisher* → **GitHub Actions**:
   - Organization or user: `Inverge-team`
   - Repository: `nexus-js`
   - Workflow filename: `release.yml`
   - Environment name: `release`

   These must match exactly, and `repository.url` in `package.json` must point at
   this repo (it does), or the publish is rejected.
2. Optional, once the first automated publish works: on the same settings page set
   **Publishing access** to *"Require two-factor authentication and disallow
   tokens"* so the workflow is the only way a version can be published.

The `release` GitHub environment is created on the first run with no protection
rules. Add required reviewers there if you want a human to approve each publish.

## Cutting a release

1. On `dev`, set `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`
   keeps `package-lock.json` in step). A pre-release such as `1.7.0-rc.1` is
   published under the **`next`** dist-tag, never `latest`, so a bare
   `npm install @inverge/nexus` keeps resolving to the newest stable version.
2. Add the version's section to `CHANGELOG.md`.
3. Merge `dev` → `main`.

`.github/workflows/release.yml` then type-checks, builds and runs the tests on
**Node 18, 20, 22 and 24**, packs, publishes to npm with provenance, then tags
`v<version>` and opens a GitHub Release with the tarball attached.

Tests run **before** the publish. A red build publishes nothing.

## Re-running is safe

A version on npm can never be replaced — even an unpublished one can't be reused.
The workflow is built around that:

- Before anything else it asks npm whether the version already exists. If it does,
  every later job is skipped and the run still succeeds, so an unrelated commit to
  `main` does not fail and cannot attempt a doomed re-publish.
- The tag and Release are only created if they do not already exist.

To release again you must **bump the version**.

## Publishing by hand

You should not need to, but `workflow_dispatch` is enabled, so you can run the
Release workflow manually against `main` from the Actions tab.

## A note on `main`

The umbrella `CLAUDE.md` carries a hard rule — *never push `main`* — because on the
**backend** repo `main` auto-deploys production. In this SDK repo `main` is the
release branch and pushing to it is the intended way to publish. Even so, an agent
working here will not push `main` for you; do the merges yourself, so a publish is
always a deliberate human act:

```bash
cd SDKs/nexus-js
git checkout main && git pull
git merge dev
git push origin main           # this triggers the release
git checkout dev
```
