# Contributing

Ferry Calendar is a fork of [Full Calendar](https://github.com/davish/obsidian-full-calendar) by Davis
Haupt. The architecture guide at [`src/README.md`](src/README.md) still describes the codebase accurately
and is the best place to start.

## Setup

Requires Node.js 18+.

```bash
npm install
npm run dev            # esbuild watch → main.js
npm run build          # typecheck + production build
npm test               # jest
npm run lint           # prettier check
npm run fix-lint       # prettier write
```

## Testing against a vault

The repository is self-contained and holds no reference to any vault. Point the deploy script at a test
vault — never your real one, since a plugin under development can rewrite event notes:

```bash
FERRY_VAULT=/path/to/test-vault npm run build:deploy
```

or persist it in `.deploy.local.json` (gitignored):

```json
{ "vault": "/path/to/test-vault" }
```

The [hot reload plugin](https://github.com/pjeby/hot-reload) picks up rebuilds without restarting
Obsidian. Disable stock Full Calendar in the same vault — two plugins writing the same event notes will
conflict.

Note that esbuild emits `main.css`, while Obsidian expects `styles.css`. The deploy script and the release
workflow both handle the rename; if you copy files by hand, do it yourself.

## Notes on dependencies

Two deviations from upstream, both deliberate:

- `fast-check` is pinned to `^2.25.0` because `zod-fast-check@0.9.0` declares a peer dependency on
  `fast-check@^2`. Upstream's `^3.8.0` cannot be installed by modern npm without `--legacy-peer-deps`.
- The lockfile pins `obsidian` to the registry release for every consumer. `obsidian-daily-notes-interface`
  declares it as a runtime dependency resolved from a git branch, which requires git-protocol fetching.

The dependency set is otherwise still upstream's, and is old. A toolchain modernisation pass is planned
before substantial feature work.

## Releasing

```bash
npm version patch|minor|major     # syncs manifest.json and versions.json
git push && git push --tags
```

Tags carry no `v` prefix and must match `manifest.json` exactly — the release workflow verifies this and
fails the build on a mismatch. It then opens a **draft** release with `main.js`, `manifest.json`, and
`styles.css` attached. Add notes and publish.
