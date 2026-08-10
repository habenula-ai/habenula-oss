# habenula

## 1.0.0

### Major Changes

- 7a39633: First release. The unscoped front door: `npx habenula <command>` runs the Habenula CLI, arguments unchanged.

  The package pins `@habenula-ai/cli` and `@habenula-ai/engine` as exact dependencies, so one npm resolution materializes the whole product and `npx habenula up` starts the engine with no second fetch. The scoped `@habenula-ai/cli` remains the lightweight, engine-free client for anyone who wants to point at an engine they already run.

  The forwarder names the engine it carries in `HABENULA_ENGINE_BIN`, and `up` reads that as an exact path before it walks `PATH`. That is what makes one resolution enough on every install shape: npm links a dependency's command for an `npx` or project-local install, but a global install links only the top-level package's, so a `PATH`-only mechanism would send `npm i -g habenula` back to the registry for an engine already on disk.

  `up` starts an engine; it cannot supply a model API key, and it says so in a notice when one is missing.
