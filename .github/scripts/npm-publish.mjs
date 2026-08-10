#!/usr/bin/env node
// The npm publish driver. Two modes, both explicit:
//
//   --validate-only   stage + transform + shape-check, stop before the guards.
//                     What packed-repo CI and the release dry-run run.
//   --publish         the full two-pass walk below; add --dry-run for the
//                     preview: npm publish gets its own --dry-run flag, and
//                     the run prints a would-publish manifest — version,
//                     packed file count, unpacked size, registry presence,
//                     outcome — to stdout and to the run summary.
//
// A bare invocation refuses: a run that could be mistaken for a publish must
// name the mode it wants.
//
// Pass one (validation), in order:
//   1. stage the eight packages into dist/npm-stage/packages/<pkg>/ — manifest,
//      built dist/, every other file the manifest's `files` array names, and
//      the shipped docs (README and LICENSE ride along on npm's own rules; the
//      changelog and security policy have to be named in the staged `files`)
//   2. apply the published-manifest transform to each staged copy
//      (npm-publish-prepare.mjs: private:false, dist entry points, no scripts;
//      engine's wrangler.toml retargeted to the packed Worker bundle)
//   3. write a staging root package.json (explicit workspaces) and re-run
//      check-pinned-deps.cjs against it — a tripwire on the transform's scope,
//      which writes no dependency edge today
//   4. assert no staged manifest declares os/cpu/libc — any one of them fails
//      installs closed on a host family this package set must support
//   5. pack each staged package ONCE, assert the packed file list carries
//      every doc staged in step 1, then run publint and attw against that
//      same tarball, with the per-package profile declared below
//
// Pass two (--publish only): read the registry once per package name, settle
// the publish set through the three guards — the version floor, version
// existence, and internal-edge resolvability (settlePublishSet below) — and
// publish the settled set in dependency order, from the same tarballs pass
// one checked. The split means a guard failure fails the run before anything
// has published; a walk that published as it went would put a leaf on the
// registry permanently and then fail on engine. Shape checks run before the
// guards on purpose: a package the guards skip has still had its shape
// checked. The publish takes no provenance flag — on the OIDC path npm
// generates and uploads the attestation itself.
//
// Staging (never transforming in place) is what lets this run against the
// committed tree without mutating it: `just oss-diff` still compares the
// packed tree to the mirror without seeing transformed manifests, and the
// gate tests the published shape rather than the committed one — a committed
// manifest points exports at ./src/*.ts while files is ["dist"], so packing
// as-committed would fail every check on a fact that is not a defect.
//
// Runs from the tree root (monorepo root or the packed tree root). dist/ is
// git-ignored, so the staging tree needs no ignore entry.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { transformManifest, retargetWranglerToml } from "./npm-publish-prepare.mjs";

/** Dependency order — build order, validate order, and (later) publish order.
 * habenula is last: it pins cli and engine, so both must publish first. */
export const PACKAGE_ORDER = ["contracts", "credentials", "governance", "audit", "tools", "engine", "cli", "habenula"];

/**
 * The declared shape-gate narrowing (the only per-package narrowing in the
 * arm). Every package is type:module and declares no types conditions, so the
 * esm-only profile applies everywhere: it ignores CJS-mode resolution failures
 * (node10, node16-cjs) and still requires node16-esm and bundler to pass. cli
 * publishes bin-only, so attw finds no types to resolve and exits clean; its
 * row keeps the profile so a typed entry point added later is checked the day
 * it appears.
 *
 * Engine alone adds --ignore-rules internal-resolution-error, and the reason
 * is structural, not temporary: its emit is bundler-mode (extensionless
 * relative specifiers node16-esm cannot resolve), and its module graph
 * statically imports a wrangler Text module (.txt) no Node resolver can load.
 * attw classifies exactly that as internal-resolution-error — imports inside
 * the published files failing node16 resolution. Engine's consumers are
 * Workers embedders who build through wrangler or esbuild, so `bundler` is
 * engine's real supported mode and the ignore says so. habenula is bin-only
 * like cli, and its row keeps the profile for the same reason cli's does.
 */
export const ATTW_ARGS = {
  contracts: ["--profile", "esm-only"],
  credentials: ["--profile", "esm-only"],
  governance: ["--profile", "esm-only"],
  audit: ["--profile", "esm-only"],
  tools: ["--profile", "esm-only"],
  engine: ["--profile", "esm-only", "--ignore-rules", "internal-resolution-error"],
  cli: ["--profile", "esm-only"],
  habenula: ["--profile", "esm-only"],
};

/**
 * Docs npm includes on its own whatever `files` says. The always-in set is
 * package.json, README, LICENSE, and the main/bin targets — and nothing else.
 */
const AUTO_INCLUDED_DOCS = ["README.md", "LICENSE"];

/**
 * Docs npm does NOT include on its own. Once a manifest declares `files` that
 * array is an allowlist, and all eight declare one, so a changelog or security
 * policy sitting beside the manifest is dropped at pack time unless a `files`
 * entry names it. Staged, then named in the staged manifest's `files` — a
 * published-shape fact belongs on the staged copy, not spread across eight
 * committed manifests that each have to remember it.
 */
const FILES_SCOPED_DOCS = ["CHANGELOG.md", "SECURITY.md"];

const PLATFORM_FIELDS = ["os", "cpu", "libc"];

/**
 * The dist-tag a below-`latest` version publishes under, so completing a
 * release the registry never received cannot downgrade `latest`. Exported so
 * the unit suite names the same string the walk passes to npm.
 */
export const BACKFILL_TAG = "backfill";

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

/**
 * Copy one package into the staging tree: package.json, everything `files`
 * names, and the shipped docs. Fails loudly on a missing build output — an
 * unbuilt package would otherwise pack an empty shell that passes no gate, and
 * the message should say "build first", not "ENOENT".
 */
export function stagePackage(treeRoot, stageRoot, pkg) {
  const srcDir = join(treeRoot, "packages", pkg);
  const outDir = join(stageRoot, "packages", pkg);
  const manifest = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));

  mkdirSync(outDir, { recursive: true });

  for (const entry of manifest.files ?? []) {
    const from = join(srcDir, entry);
    if (!existsSync(from)) {
      throw new Error(
        `npm-publish: packages/${pkg} names "${entry}" in files but it does not exist — run the builds first (just oss-build)`,
      );
    }
    cpSync(from, join(outDir, entry), { recursive: true });
  }
  for (const doc of AUTO_INCLUDED_DOCS) {
    const from = join(srcDir, doc);
    if (existsSync(from)) cpSync(from, join(outDir, doc));
  }

  // Stage first, then name each one in `files` — an entry pointing at a file
  // the staging tree lacks would pack a phantom. A manifest with no `files` at
  // all is left alone: npm ships everything not ignored, docs included, and
  // minting an allowlist here would narrow the tarball instead of widening it.
  const stagedDocs = FILES_SCOPED_DOCS.filter((doc) => existsSync(join(srcDir, doc)));
  for (const doc of stagedDocs) cpSync(join(srcDir, doc), join(outDir, doc));
  if (manifest.files !== undefined) {
    manifest.files = [...new Set([...manifest.files, ...stagedDocs])];
  }

  writeFileSync(join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return outDir;
}

/**
 * Assert every doc staged for this package survived the pack. A dropped
 * changelog or security policy is invisible everywhere else in this gate:
 * publint and attw read entry points, not documentation, and the staging step
 * looks correct right up to the moment npm applies the `files` allowlist.
 */
export function assertStagedDocsPacked(stagedDir, pkg, packedPaths) {
  const packed = new Set(packedPaths);
  for (const doc of [...AUTO_INCLUDED_DOCS, ...FILES_SCOPED_DOCS]) {
    if (!existsSync(join(stagedDir, doc))) continue;
    if (!packed.has(doc)) {
      throw new Error(
        `npm-publish: packages/${pkg} staged ${doc} but the tarball does not carry it — npm packs a doc only when it auto-includes it or a \`files\` entry names it`,
      );
    }
  }
}

/** Stage all eight, transform each staged copy, write the staging root manifest. */
export function buildStagingTree(treeRoot, stageRoot) {
  rmSync(stageRoot, { recursive: true, force: true });
  for (const pkg of PACKAGE_ORDER) {
    const outDir = stagePackage(treeRoot, stageRoot, pkg);
    transformManifest(outDir, pkg);
    if (pkg === "engine") retargetWranglerToml(outDir);
  }
  writeFileSync(
    join(stageRoot, "package.json"),
    JSON.stringify(
      {
        name: "habenula-npm-stage",
        version: "0.0.0",
        private: true,
        workspaces: PACKAGE_ORDER.map((pkg) => `packages/${pkg}`),
      },
      null,
      2,
    ) + "\n",
  );
}

/** Assert no staged manifest declares a platform field (step 4 above). */
export function assertNoPlatformFields(stageRoot) {
  for (const pkg of PACKAGE_ORDER) {
    const manifest = JSON.parse(readFileSync(join(stageRoot, "packages", pkg, "package.json"), "utf8"));
    for (const field of PLATFORM_FIELDS) {
      if (field in manifest) {
        throw new Error(
          `npm-publish: packages/${pkg} declares "${field}" — npm evaluates platform fields on every install, and this package set must install on Linux, macOS, and Windows`,
        );
      }
    }
  }
}

// --- the registry read and the three guards -----------------------------------

/**
 * Read one package's published versions and its `latest` dist-tag. Three
 * outcomes, all distinguished structurally rather than by npm's error prose
 * (which moves across majors — npm 11 reports a missing version and a missing
 * package as the same E404, and only the message text differs, so the version
 * list is queried instead):
 *
 *   { versions: [...], latest } the package exists (hit vs. miss is a local
 *                               membership check; latest is undefined when the
 *                               tag was never set — bootstrap stubs)
 *   { unknownPackage: true }    the registry answers 404 for the name itself
 *   throws                      anything else — 5xx, DNS, a refused connection.
 *                               A guess in either direction defeats the
 *                               idempotent re-run this read exists to give.
 *
 * Verified against npm 11.16.0, the npm the publish workflow asserts. Asking
 * for two fields keeps the output an object keyed by field, so nothing here
 * depends on npm's single-value collapse.
 */
export function readRegistryVersions(name, execFn = execFileSync) {
  let stdout;
  try {
    // stderr captured, not inherited: an unknown package is an expected
    // outcome here (pre-bootstrap names), and npm's E404 banner would spam
    // the release log for a case the settle step reports in one line.
    stdout = execFn("npm", ["view", name, "versions", "dist-tags", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const body = typeof err.stdout === "string" ? err.stdout : "";
    let code;
    try {
      code = JSON.parse(body)?.error?.code;
    } catch {
      code = undefined;
    }
    if (code === "E404") return { unknownPackage: true };
    throw new Error(
      `npm-publish: the registry read for ${name} failed with ${code ?? "no parseable error"} — not publishing anything against an unreadable registry.\n${body || err.message}`,
    );
  }
  const parsed = JSON.parse(stdout);
  const versions = Array.isArray(parsed.versions) ? parsed.versions : [parsed.versions];
  return { versions, latest: parsed["dist-tags"]?.latest };
}

/**
 * Order two `x.y.z(-prerelease)?` versions: negative when a < b. Numeric on
 * the triple; on an equal triple a prerelease sorts below its release, and
 * two prereleases compare as strings — a deliberate approximation, used only
 * to refuse a backward move of `latest`, where the compared values are the
 * candidate and a release version.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [triple, ...pre] = v.split("-");
    return { nums: triple.split(".").map(Number), pre: pre.join("-") || undefined };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** The internal edges a consumer resolves: @habenula-ai/* in the three
 * consumer-facing dependency sections. devDependencies is deliberately out of
 * scope — npm never resolves it for a consumer, and cli pins siblings there
 * that must not block a cli release (its bundle already inlined what it uses). */
export function internalEdges(manifest) {
  const edges = {};
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, version] of Object.entries(manifest[section] ?? {})) {
      if (dep.startsWith("@habenula-ai/")) edges[dep] = version;
    }
  }
  return edges;
}

/**
 * Settle the publish set: pure, so the guards are testable without a registry.
 *
 *   staged             [{ pkg, name, version, edges }] in dependency order
 *   registry           name → readRegistryVersions() result
 *
 * Guard one skips (and logs) a package still at 0.0.0 — the ordinary shape of
 * a package no changeset has versioned, never an error. Guard two skips a
 * version the registry already has, which is what makes a re-run reconcile
 * instead of republishing; a package name the registry has never seen is a
 * hard fail for a publish candidate, because OIDC trusted publishing cannot
 * create a name — the one-time bootstrap must run first. Guard three asserts
 * every internal edge of everything about to publish resolves — on the
 * registry at that exact version, or in this run's publish set — and fails
 * the whole run before anything publishes.
 *
 * A candidate below the registry's `latest` publishes as a BACKFILL: the same
 * tarball, uploaded under the `backfill` dist-tag so `latest` does not move
 * backward. This is the completion path for a release whose publish never
 * ran and was then overtaken by a newer one — its git tag and its GitHub
 * Release exist, so the version has to become installable, and the only
 * alternative is a version that is announced and permanently unobtainable.
 * Entries carry `distTag` when settled this way, and nothing else about the
 * walk changes.
 */
export function settlePublishSet(staged, registry) {
  const skips = [];
  const candidates = [];
  const inRun = new Map();

  for (const entry of staged) {
    if (entry.version === "0.0.0") {
      skips.push({ pkg: entry.pkg, reason: "version floor: still at 0.0.0 (no changeset has versioned it)" });
      continue;
    }
    const reg = registry[entry.name];
    if (reg.unknownPackage) {
      throw new Error(
        `npm-publish: ${entry.name} is not on the registry at all — OIDC trusted publishing cannot create a name. Run the one-time bootstrap first: a maintainer publishes the name by hand from a local checkout, using an npm account authorized on the scope.`,
      );
    }
    if (reg.versions.includes(entry.version)) {
      skips.push({ pkg: entry.pkg, reason: `${entry.version} is already on the registry (re-run reconciles, never republishes)` });
      continue;
    }
    // An ordinary publish runs with no --tag, which moves `latest`. A
    // candidate below the current `latest` must not: the release policy is
    // roll-forward and consumers of `latest` are never downgraded. It is
    // still published, under the `backfill` tag, because the version is
    // already tagged and released on the repository side and the hole is
    // worse than the older tarball.
    if (reg.latest !== undefined && compareVersions(entry.version, reg.latest) < 0) {
      candidates.push({ ...entry, distTag: BACKFILL_TAG });
      inRun.set(entry.name, entry.version);
      continue;
    }
    candidates.push(entry);
    inRun.set(entry.name, entry.version);
  }

  for (const entry of candidates) {
    for (const [dep, version] of Object.entries(entry.edges)) {
      const reg = registry[dep];
      const onRegistry = reg !== undefined && !reg.unknownPackage && reg.versions.includes(version);
      if (!onRegistry && inRun.get(dep) !== version) {
        throw new Error(
          `npm-publish: ${entry.name}@${entry.version} pins ${dep}@${version}, which is neither on the registry nor in this run's publish set — publishing it would ship a tarball no consumer can install. Nothing was published. (On a first release, version the five leaves and engine together so every internal edge resolves inside the same run.)`,
        );
      }
    }
  }

  return { publish: candidates, skips };
}

/** Render a byte count for the preview manifest. */
function formatSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * The preview's would-publish manifest (--publish --dry-run only): one row
 * per staged package — version, packed file count, unpacked size, both read
 * from the `npm pack --json` output pass one already produced — plus what
 * the registry read found and how the guards settled it. A version the
 * registry already holds reads as a skip, never an error: reconcile
 * semantics, the same ones a real re-run relies on. Pure and exported so the
 * unit suite covers it without a registry.
 */
export function buildPublishManifest(staged, registry, { publish, skips }) {
  const publishing = new Map(publish.map((entry) => [entry.pkg, entry.distTag]));
  const skipReason = new Map(skips.map((skip) => [skip.pkg, skip.reason]));
  const rows = staged.map((entry) => {
    const reg = registry[entry.name];
    const onRegistry =
      reg !== undefined && !reg.unknownPackage && reg.versions.includes(entry.version);
    const outcome = publishing.has(entry.pkg)
      ? publishing.get(entry.pkg)
        ? `would publish under --tag ${publishing.get(entry.pkg)} (below latest; latest unmoved)`
        : "would publish"
      : `skip — ${skipReason.get(entry.pkg) ?? "not in the publish set"}`;
    return `| ${entry.name} | ${entry.version} | ${entry.fileCount ?? "unknown"} | ${formatSize(entry.unpackedSize)} | ${onRegistry ? "already published" : "absent"} | ${outcome} |`;
  });
  return [
    "### npm publish preview",
    "",
    "| package | version | packed files | unpacked size | on the registry | outcome |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "No upload ran. A version already on the registry is a skip, never an error — a real re-run reconciles. Provenance attestation is generated only on a real publish.",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const validateOnly = args.includes("--validate-only");
  const publishMode = args.includes("--publish");
  const dryRun = args.includes("--dry-run");
  if (validateOnly === publishMode) {
    console.error(
      "npm-publish: name the mode — exactly one of --validate-only or --publish (add --dry-run to preview a publish). Refusing a run that could be mistaken for a publish.",
    );
    process.exit(1);
  }

  const treeRoot = process.cwd();
  const stageRoot = join(treeRoot, "dist", "npm-stage");

  // The pin check ships at scripts/check-pinned-deps.cjs. This driver sits at a
  // different depth in the authoring tree than in a packed tree, so resolve it
  // from the tree root rather than relative to this file.
  const pinCheck = join(treeRoot, "scripts", "check-pinned-deps.cjs");
  if (!existsSync(pinCheck)) {
    console.error(`npm-publish: expected the pin check at ${pinCheck}`);
    process.exit(1);
  }

  console.log(`[npm-publish] staging eight packages into ${stageRoot}`);
  buildStagingTree(treeRoot, stageRoot);

  console.log("[npm-publish] re-running the dependency pin check against the staged manifests");
  run("node", [pinCheck, stageRoot]);

  assertNoPlatformFields(stageRoot);

  const tarballDir = join(stageRoot, "tarballs");
  mkdirSync(tarballDir, { recursive: true });

  const staged = [];
  for (const pkg of PACKAGE_ORDER) {
    const pkgDir = join(stageRoot, "packages", pkg);
    console.log(`[npm-publish] pack + shape gate: ${pkg}`);
    // One pack per package: publint and attw read the same bytes that would
    // publish, instead of each producing a tarball of its own. --json for the
    // packed file list, which is the only place a dropped doc shows up.
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", tarballDir], {
        cwd: pkgDir,
        encoding: "utf8",
      }),
    )[0];
    const tarballPath = resolve(tarballDir, packed.filename);
    assertStagedDocsPacked(
      pkgDir,
      pkg,
      packed.files.map((f) => f.path),
    );

    run("npx", ["publint", "run", tarballPath, "--strict"], { cwd: treeRoot });
    run("npx", ["attw", tarballPath, ...ATTW_ARGS[pkg]], { cwd: treeRoot });

    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    staged.push({
      pkg,
      name: manifest.name,
      version: manifest.version,
      edges: internalEdges(manifest),
      tarballPath,
      // For the preview manifest — read from the pack output above rather
      // than packing a second time.
      fileCount: packed.files.length,
      unpackedSize: packed.unpackedSize,
    });
  }

  if (validateOnly) {
    console.log("[npm-publish] validate-only: all eight staged, packed, and shape-checked. No publish attempted.");
    return;
  }

  // Pass two. One registry read per package name — the eight candidates and
  // every internal edge share the same eight names.
  console.log("[npm-publish] reading the registry to settle the publish set");
  const registry = {};
  for (const entry of staged) {
    registry[entry.name] = readRegistryVersions(entry.name);
  }

  const { publish, skips } = settlePublishSet(staged, registry);
  for (const skip of skips) {
    console.log(`[npm-publish] skip ${skip.pkg}: ${skip.reason}`);
  }
  if (publish.length === 0) {
    console.log("[npm-publish] nothing to publish — every package was skipped by the guards. A re-run reconciles; this is the idempotent no-op, not an error.");
  } else {
    for (const entry of publish) {
      console.log(
        `[npm-publish] publish${dryRun ? " (dry-run)" : ""}: ${entry.name}@${entry.version}${
          entry.distTag ? ` (--tag ${entry.distTag}: below the registry's latest, so latest stays where it is)` : ""
        }`,
      );
      // The tarball's own manifest carries publishConfig.access; no provenance
      // flag — on the OIDC path npm generates and uploads the attestation. A
      // backfill is the only publish that names a tag; every other one lets
      // npm move `latest`.
      run(
        "npm",
        [
          "publish",
          entry.tarballPath,
          ...(entry.distTag ? ["--tag", entry.distTag] : []),
          ...(dryRun ? ["--dry-run"] : []),
        ],
        { cwd: treeRoot },
      );
    }
    console.log(
      `[npm-publish] published ${publish.length} package(s)${dryRun ? " (dry-run — nothing reached the registry)" : ""}, ${skips.length} skipped.`,
    );
  }

  // The preview's receipt: the would-publish manifest and the registry
  // presence per package. Always to stdout, and additionally to the run
  // summary when GitHub provides one — a flag that would always be passed
  // earns nothing.
  if (dryRun) {
    const preview = buildPublishManifest(staged, registry, { publish, skips });
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, preview + "\n");
    }
    console.log(preview);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
