#!/usr/bin/env node
// Tarball smoke tests — what publint and attw cannot see. Runs after
// npm-publish.mjs --validate-only, against the tarballs that run packed.
//
//   1. Wildcard resolution: attw enumerates declared entrypoints and cannot
//      expand `./*` or `./services/*` — the two riskiest retargets. Install
//      the packed tarballs into a scratch project (no workspace, no
//      overrides — a real consumer's shape) and import every real wildcard
//      target, enumerated from the staged dist trees.
//   2. bin execution: neither tool reads a `bin` entry. Execute the cli bin
//      and the umbrella's forwarder directly (the only check that catches a
//      bin target with no shebang — a shell error at run time and nothing at
//      all at pack time), and reach the engine daemon through npm's single-bin
//      fallback (`npm exec` on the package name — the same mechanism as
//      `npx @habenula-ai/engine`), asserting it reaches its listening state
//      before stopping it. Each bin runs at its own declared path: the cli and
//      the umbrella both declare the name `habenula`, so which one npm links
//      into node_modules/.bin is undefined, and executing the link would test
//      one of them at random.
//   3. Engine module-surface resolution: typecheck a consumer of
//      `@habenula-ai/engine` against the installed tarball, then resolve and
//      load the surface in engine's supported mode — a bundler pass (esbuild
//      with a Text loader, cloudflare:* external), which is how every Workers
//      embedder consumes it. The five leaves load under plain Node above;
//      engine is bundler-only by declared narrowing.
//
// Runs from the tree root, after `just oss-build` and the validate driver.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const treeRoot = process.cwd();
const stageRoot = join(treeRoot, "dist", "npm-stage");
const tarballDir = join(stageRoot, "tarballs");
const smokeRoot = join(stageRoot, "smoke");

const PACKAGES = ["contracts", "credentials", "governance", "audit", "tools", "engine", "cli", "habenula"];

function fail(message) {
  console.error(`[tarball-smoke] FAIL: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

if (!existsSync(tarballDir)) {
  fail(`no tarballs at ${tarballDir} — run the validate driver first (just oss-verify-tarballs)`);
}
const tarballs = readdirSync(tarballDir).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== PACKAGES.length) {
  fail(`expected ${PACKAGES.length} tarballs, found ${tarballs.length}: ${tarballs.join(", ")}`);
}

// --- scratch consumer install (no workspace, no overrides) -------------------

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
writeFileSync(
  join(smokeRoot, "package.json"),
  JSON.stringify({ name: "habenula-tarball-smoke", version: "0.0.0", private: true, type: "module" }, null, 2) + "\n",
);
console.log("[tarball-smoke] installing the eight packed tarballs into a scratch consumer");
run("npm", ["install", "--no-audit", "--no-fund", ...tarballs.map((f) => join(tarballDir, f))], {
  cwd: smokeRoot,
});

// --- 1. wildcard resolution ---------------------------------------------------

/** Enumerate the real targets of a package's wildcard exports from its staged dist. */
function wildcardTargets(pkg, subdir = "") {
  const dir = join(stageRoot, "packages", pkg, "dist", subdir);
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...wildcardTargets(pkg, join(subdir, entry.name)));
    else if (entry.name.endsWith(".js")) out.push(join(subdir, entry.name).replace(/\.js$/, ""));
  }
  return out;
}

const imports = [
  // subpath exports declared without wildcards
  "@habenula-ai/contracts",
  "@habenula-ai/contracts/requests",
  "@habenula-ai/contracts/responses",
  "@habenula-ai/governance",
  "@habenula-ai/audit",
  "@habenula-ai/credentials",
  "@habenula-ai/tools",
  // every real `./*` target
  ...wildcardTargets("credentials").map((t) => `@habenula-ai/credentials/${t}`),
  ...wildcardTargets("governance").map((t) => `@habenula-ai/governance/${t}`),
  ...wildcardTargets("audit").map((t) => `@habenula-ai/audit/${t}`),
  // every real `./services/*` target (the enumeration carries the services/ prefix)
  ...wildcardTargets("tools", "services").map((t) => `@habenula-ai/tools/${t}`),
];

console.log(`[tarball-smoke] importing ${imports.length} specifiers (incl. every wildcard target)`);
const importer = imports.map((s) => `await import(${JSON.stringify(s)});`).join("\n");
writeFileSync(join(smokeRoot, "wildcard-smoke.mjs"), importer + "\nconsole.log('wildcard imports OK');\n");
run("node", ["wildcard-smoke.mjs"], { cwd: smokeRoot });

// --- 2. bin execution ----------------------------------------------------------

/**
 * A package's own bin path, read from its installed manifest. Not
 * node_modules/.bin: the cli and the umbrella both declare `habenula`, so the
 * link resolves to whichever npm wrote last and the other bin never runs.
 * The file is executed rather than passed to node, which is what exercises the
 * shebang and the exec bit.
 */
function declaredBin(pkgDir, binName) {
  const pkgRoot = join(smokeRoot, "node_modules", pkgDir);
  const manifestPath = join(pkgRoot, "package.json");
  if (!existsSync(manifestPath)) fail(`npm did not install ${pkgDir}`);
  const target = JSON.parse(readFileSync(manifestPath, "utf8")).bin?.[binName];
  if (typeof target !== "string") fail(`${pkgDir} declares no \`${binName}\` bin`);
  const binPath = join(pkgRoot, target);
  if (!existsSync(binPath)) {
    fail(`${pkgDir} declares bin ${binName} → ${target}, which its tarball does not ship`);
  }
  return binPath;
}

console.log("[tarball-smoke] executing the cli bin directly (shebang + exec bit)");
if (!existsSync(join(smokeRoot, "node_modules", ".bin", "habenula"))) {
  fail("npm linked no habenula bin at all");
}
run(declaredBin("@habenula-ai/cli", "habenula"), ["--version"], { cwd: smokeRoot });

// The forwarder resolves the CLI's *published* manifest and reads the bin path
// out of it. npm-publish-prepare.mjs rewrites that manifest, so this is the
// only gate that runs the published forwarder against the published CLI —
// in-repo the forwarder only ever sees the committed manifest.
console.log("[tarball-smoke] executing the umbrella forwarder (against the published cli manifest)");
run(declaredBin("habenula", "habenula"), ["--version"], { cwd: smokeRoot });

console.log("[tarball-smoke] reaching the engine daemon via npm's single-bin fallback");
const port = 30000 + Math.floor(Math.random() * 10000);
const key = execFileSync("openssl", ["rand", "-hex", "32"], { encoding: "utf8" }).trim();
await new Promise((resolveWait, rejectWait) => {
  // detached: npm wraps the bin in its own process, so the stop signal goes to
  // the process group — killing npm alone would orphan a listening daemon.
  const child = spawn("npm", ["exec", "--no", "--", "@habenula-ai/engine"], {
    cwd: smokeRoot,
    detached: true,
    env: {
      ...process.env,
      CREDENTIAL_ENCRYPTION_KEY: key,
      HABENULA_PORT: String(port),
      HABENULA_PERSIST_ROOT: join(smokeRoot, "persist"),
    },
  });
  const stopGroup = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  let settled = false;
  let output = "";
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    stopGroup();
    rejectWait(new Error(`engine bin did not reach its listening state in 90s. Output:\n${output}`));
  }, 90_000);
  const onData = (chunk) => {
    output += chunk.toString();
    if (!settled && output.includes("habenula-engine ready at")) {
      settled = true;
      clearTimeout(timer);
      console.log("[tarball-smoke] engine daemon reached its listening state; stopping it");
      stopGroup();
      resolveWait();
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectWait(new Error(`engine bin exited (${code}) before its ready line. Output:\n${output}`));
  });
}).catch((err) => fail(err.message));

// --- 3. engine module-surface resolution --------------------------------------

console.log("[tarball-smoke] typechecking a consumer of @habenula-ai/engine");
writeFileSync(
  join(smokeRoot, "engine-consumer.ts"),
  `import handler, { UserAgent, resolveCallbackUrl } from "@habenula-ai/engine";
export type H = typeof handler;
export type UA = InstanceType<typeof UserAgent>;
export const url: typeof resolveCallbackUrl = resolveCallbackUrl;
`,
);
writeFileSync(
  join(smokeRoot, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
        // The Workers-ecosystem baseline: @cloudflare/workers-types redeclares
        // globals and does not survive skipLibCheck:false in any project.
        skipLibCheck: true,
        types: ["@cloudflare/workers-types"],
        noEmit: true,
      },
      include: ["engine-consumer.ts"],
    },
    null,
    2,
  ) + "\n",
);
run("npx", ["tsc", "-p", join(smokeRoot, "tsconfig.json")], { cwd: treeRoot });

console.log("[tarball-smoke] resolving + loading the engine surface in its supported mode (bundler)");
writeFileSync(join(smokeRoot, "engine-entry.js"), 'import "@habenula-ai/engine";\n');
run(
  "npx",
  [
    "esbuild",
    join(smokeRoot, "engine-entry.js"),
    "--bundle",
    "--format=esm",
    // platform=node externalizes the Node builtins (bare and node:-prefixed)
    // the way wrangler's nodejs_compat does; package + relative resolution —
    // the thing under test — is unaffected. conditions=workerd picks the
    // Workers-flavored package entries, matching how embedders build.
    "--platform=node",
    "--conditions=workerd",
    "--external:cloudflare:*",
    "--loader:.txt=text",
    `--outfile=${join(smokeRoot, "engine-bundle.js")}`,
    "--log-level=error",
  ],
  // cwd is the tree root so npx resolves the tree's pinned esbuild instead of
  // offering to install one; import resolution still walks up from the entry
  // file's own directory, i.e. the scratch consumer's node_modules.
  { cwd: treeRoot },
);

console.log("[tarball-smoke] OK: wildcard imports, both bins, engine consumer typecheck + bundler load.");
