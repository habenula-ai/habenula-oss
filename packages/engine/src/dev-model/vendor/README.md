# Vendored assets

## cytoscape-3.34.0.min.js.txt

- **What:** Cytoscape.js v3.34.0 browser dist (`dist/cytoscape.min.js` from the npm tarball), MIT, license header intact. Imported as a Text module and inlined into the dev visual-model page (`/dev/model`). Never imported by Worker logic.
- **Source:** https://registry.npmjs.org/cytoscape/-/cytoscape-3.34.0.tgz
- **sha256:** 9c2a3bf2592e0b14a1f7bec07c03a54f16dedf32af9cd0af155c716aa6c87bc3
- **Dependency-stability pass:** 2026-07-09 — stable tier, released 2026-06-02 (>7 days), zero runtime dependencies, no package.json entry (vendored browser artifact, not a bundler import).
- **Upgrading:** re-run the dependency-stability checklist, replace the file from the new tarball's `dist/cytoscape.min.js`, update the filename, this entry, and the import in `../page.ts`.
