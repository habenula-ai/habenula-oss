// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal ambient declarations for the Node APIs the CLI uses.
//
// We deliberately do not depend on @types/node. The CLI runs on Node (via tsx
// in dev, via the bundled dist/index.js when installed) and uses only a tiny
// slice of the standard library; declaring just what we touch keeps the
// dependency surface zero. The same pattern is used by
// packages/engine/src/node-crypto.d.ts.

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  platform: string;
  stdin: unknown;
  // Read only at the composition root (index.ts): src/engine/** and the
  // up/down commands may not touch `process` at all (see eslint.config.mjs),
  // so the working directory and the signal effect arrive as injected deps.
  cwd(): string;
  kill(pid: number, signal?: number | string): void;
  // The running Node binary — the command-level tests spawn the stub engine
  // through it so the suite never depends on a `node` PATH lookup.
  execPath: string;
  // Test-tier: the down tests use the test process itself as a pid that is
  // provably alive and ours while provably not answering a port.
  pid: number;
  // Signal listeners: the standalone `connect` installs a SIGINT handler for
  // the wait's duration and removes it in `finally`.
  on(event: "SIGINT" | "exit", listener: () => void): void;
  removeListener(event: "SIGINT" | "exit", listener: () => void): void;
  stdout: {
    write(chunk: string): boolean;
    // Present on a TTY; absent (undefined) when piped/redirected. `columns` is
    // the terminal width used by the width-correct wrap (fallback 80).
    isTTY?: boolean;
    columns?: number;
  };
  stderr: { write(chunk: string): boolean };
};

declare module "node:readline" {
  // Keystroke parsing only (the raw-mode line editor). Not
  // readline's line editor — the editor owns the buffer. Emits `keypress`
  // events on the stream; the second arg is unused here.
  function emitKeypressEvents(stream: unknown, iface?: unknown): void;
}

declare module "node:readline/promises" {
  interface Interface {
    question(query: string): Promise<string>;
    close(): void;
    on(event: "close", listener: () => void): this;
    // The dump-file reader consumes an interface as a line stream
    // (`for await (const line of rl)`) so a multi-hundred-MB dump is never
    // held whole.
    [Symbol.asyncIterator](): AsyncIterableIterator<string>;
  }
  function createInterface(options: {
    input: unknown;
    output?: unknown;
    terminal?: boolean;
  }): Interface;
}

declare module "node:url" {
  function fileURLToPath(url: URL | string): string;
}

declare module "node:fs" {
  // Minimal slice: the static render-site regression guard reads chat.ts
  // source; `log dump` writes its JSONL file (truncate-then-append, one whole
  // page per append so a cancel never tears a line); `log verify --file`
  // streams a dump back through a read stream; the engine-lifecycle modules
  // (src/engine/) own the persist root's config, run record, and log files.
  function readFileSync(path: string, encoding: "utf8"): string;
  function writeFileSync(path: string, data: string): void;
  function writeFileSync(
    path: string,
    data: string,
    options: { flag?: string; mode?: number },
  ): void;
  function appendFileSync(path: string, data: string): void;
  function createReadStream(path: string): unknown;
  function mkdirSync(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): string | undefined;
  function existsSync(path: string): boolean;
  function openSync(path: string, flags: string, mode?: number): number;
  function closeSync(fd: number): void;
  function renameSync(oldPath: string, newPath: string): void;
  function unlinkSync(path: string): void;
  // The PATH walk's executable test (X_OK), which is what `which` itself tests.
  function accessSync(path: string, mode?: number): void;
  const constants: { X_OK: number };
  // Test-tier slice: the behavioral tests run against real mkdtempSync roots
  // and assert every file lands at 0600; they share this typecheck program.
  function mkdtempSync(prefix: string): string;
  function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
  function statSync(path: string): { mode: number; isFile(): boolean };
  function readdirSync(path: string): string[];
  function chmodSync(path: string, mode: number): void;
}

declare module "node:os" {
  function homedir(): string;
  function tmpdir(): string;
}

declare module "node:path" {
  function join(...parts: string[]): string;
  function dirname(p: string): string;
  // PATH-entry separator (":" POSIX, ";" Windows) for the engine-command walk.
  const delimiter: string;
}

declare module "node:crypto" {
  // Secret generation (credential key, drive token) and the merge's temp-file
  // suffix — random rather than pid-based, because src/engine/ may not read
  // `process`.
  function randomBytes(size: number): { toString(enc: "hex"): string };
}

// `import.meta.url` (used to locate the presence helper relative to the package
// root) — neither lib.dom nor our zero-dep policy provides it.
interface ImportMeta {
  url: string;
}

declare module "node:child_process" {
  interface ChildProcess {
    unref(): void;
    // Set once the child exists; `undefined` when the spawn itself failed.
    pid?: number;
    on(
      event: "exit",
      listener: (code: number | null, signal: string | null) => void,
    ): void;
    // A command that cannot be spawned (ENOENT) arrives as 'error', and
    // 'exit' may never fire.
    on(event: "error", listener: (err: unknown) => void): void;
  }
  function spawn(
    command: string,
    args?: string[],
    options?: {
      // The daemon spawn passes [ "ignore", fd, fd ] — stdout and stderr onto
      // the fresh engine.log descriptor.
      stdio?: "ignore" | "inherit" | "pipe" | (string | number)[];
      detached?: boolean;
      env?: Record<string, string | undefined>;
      // Always false on the engine spawn: HABENULA_ENGINE_CMD is split into an
      // argv, never handed to a shell.
      shell?: false;
    },
  ): ChildProcess;
  // Test-tier slice: the main()-refusal test drives the real entry as a child
  // process and reads its exit code and stderr.
  function spawnSync(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: "utf8";
      timeout?: number;
    },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module "node:http" {
  // Test-tier slice: the up/down command tests stand up a junk listener to
  // exercise the port classifier's non-engine branch.
  interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string): void;
  }
  interface IncomingMessage {
    method?: string;
    url?: string;
  }
  function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): {
    listen(port: number, host: string, callback?: () => void): void;
    close(): void;
  };
}

// The engine version inlined by build.mjs (esbuild `define`). It exists only
// inside the bundler: source runs (tsx, vitest, tsc) see it undefined and
// fall back to a gated placeholder — see resolve-engine-command.ts.
declare const __HBN_ENGINE_VERSION__: string | undefined;

declare module "eslint" {
  // Minimal slice for the process-ban guard test, which runs eslint's own
  // lintText over a virtual src/engine/ path and asserts the block reports.
  export class ESLint {
    constructor(options?: { cwd?: string });
    lintText(
      code: string,
      options?: { filePath?: string },
    ): Promise<
      { messages: { ruleId: string | null; message: string }[]; errorCount: number }[]
    >;
  }
}
