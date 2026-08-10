// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The strict environment-file parser for the shared config under the persist
 * root. Same line shape as the `.env` a container self-hoster already keeps,
 * but a line this parser does not understand is a refusal, never a skip: the
 * generation guards treat a config with no CREDENTIAL_ENCRYPTION_KEY as a
 * licence to generate one, so a silently dropped key line is a path to a
 * second key over an existing store — the one outcome this file's owner
 * cannot allow.
 *
 * Pure over a string. The filesystem seam is config-file.ts.
 */

/**
 * Variables the file refuses by name, each because a value here would not be
 * honoured. The first two decide which file this is and which store it
 * configures, so a value inside the file is circular — a config would be
 * describing a store its own guards never inspected. The two URLs are read
 * from the environment only: the CLI derives its target from HABENULA_PORT, so
 * a line naming an origin would sit in the file looking honoured while the CLI
 * dialled somewhere else. Honouring them instead would be worse than ignoring
 * them, because a file that both redirects the client to a remote origin and
 * holds the drive token is exactly the disclosure the token scope check exists
 * to prevent.
 */
export const ENV_ONLY_VARIABLES = [
  "HABENULA_CONFIG",
  "HABENULA_PERSIST_ROOT",
  "HABENULA_API_URL",
  "HABENULA_INTERNAL_MCP_URL",
] as const;

/**
 * Why each refused-by-name variable is refused, as the middle of its message. A
 * Map rather than an object: a lookup keyed by user text on a plain object finds
 * inherited Object.prototype names, so a line reading `constructor=2` would be
 * refused with a message built from `Object.prototype.constructor`.
 */
const ENV_ONLY_REASON = new Map<string, string>([
  [
    "HABENULA_CONFIG",
    "cannot be set from inside this file — it decides which config file and store are read",
  ],
  [
    "HABENULA_PERSIST_ROOT",
    "cannot be set from inside this file — it decides which config file and store are read",
  ],
  [
    "HABENULA_API_URL",
    "is not read from this file — the engine URL derives from HABENULA_PORT",
  ],
  [
    "HABENULA_INTERNAL_MCP_URL",
    "is not read from this file — the engine URL derives from HABENULA_PORT",
  ],
]);

/**
 * A variable name: letters, digits, and underscores, not starting with a digit.
 * Unvalidated, a quoted key (`"INTERNAL_MCP_TOKEN"=abc`) or one still carrying
 * an `export` prefix stores the secret under a name nothing reads, and the CLI
 * then reports the file as holding no token while the token sits in the file.
 */
const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split an unquoted value from a trailing `# comment`, matching how a shell
 * sourcing the same file reads it: `abc#def` keeps the hash (it is one word),
 * `abc #def` does not (the comment is a separate word). Without this, a user
 * annotating their own credential key glues the note onto the key and the
 * engine derives a different one — a decrypt failure at tool-execution time,
 * nowhere near the line that caused it.
 */
function splitUnquotedComment(raw: string): string {
  const at = raw.search(/\s#/);
  return at === -1 ? raw : raw.slice(0, at);
}

/**
 * A refused config file: the message carries the file label and the one-based
 * line number, so the refusal a user sees names the exact line to fix.
 */
export class ConfigFileError extends Error {
  constructor(
    public readonly label: string,
    public readonly lineNumber: number,
    detail: string,
  ) {
    super(`${label}, line ${lineNumber}: ${detail}`);
    this.name = "ConfigFileError";
  }
}

/**
 * Parse the config file's text. Per line: trim; skip empty and `#`-leading;
 * strip a leading `export` and its whitespace; split at the first `=`; trim
 * both halves; check the key is a variable name; then read the value the way a
 * shell sourcing this file would — one matching pair of surrounding quotes
 * stripped, and an unquoted trailing `# comment` dropped. Nothing is
 * interpolated and no escape is honoured. A duplicate key keeps the last value.
 *
 * Throws ConfigFileError for a line with no `=`, an empty or malformed key, an
 * environment-only variable, an unterminated quote, or text after a closing
 * quote. Every one of those is a line whose meaning cannot be guessed at, and
 * guessing is what this parser exists not to do. The environment-only refusal
 * belongs to OUR config file; a working-directory `.env` is somebody else's
 * file where those names are legal, so its reader passes
 * `pathVariables: "allow"`.
 *
 * The record has a null prototype: `vars.__proto__ = value` on a plain object
 * hits the prototype setter and stores nothing, which would be a line reported
 * as parsed and silently dropped — the one outcome the refusals above exist to
 * rule out.
 */
export function parseEnvFile(
  text: string,
  label: string,
  options?: { pathVariables?: "refuse" | "allow" },
): Record<string, string> {
  const vars: Record<string, string> = Object.create(null);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    let line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "");

    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new ConfigFileError(
        label,
        lineNumber,
        "expected KEY=value. Fix or remove this line — nothing in this file is skipped, because a silently dropped line could hide a secret from the engine.",
      );
    }
    const key = line.slice(0, eq).trim();
    if (key.length === 0) {
      throw new ConfigFileError(
        label,
        lineNumber,
        "expected KEY=value with a non-empty key. Fix or remove this line.",
      );
    }
    if (!KEY_SHAPE.test(key)) {
      throw new ConfigFileError(
        label,
        lineNumber,
        `\`${key}\` is not a variable name — a key is letters, digits, and underscores, never quoted, and never starts with a digit. Fix or remove this line.`,
      );
    }
    const envOnlyReason =
      options?.pathVariables === "allow" ? undefined : ENV_ONLY_REASON.get(key);
    if (envOnlyReason !== undefined) {
      throw new ConfigFileError(
        label,
        lineNumber,
        `${key} ${envOnlyReason}. Remove the line and export it in your shell instead.`,
      );
    }

    vars[key] = readValue(line.slice(eq + 1).trim(), label, lineNumber);
  }
  return vars;
}

/**
 * The value half of one line. A quoted value ends at its closing quote, so a
 * `#` inside quotes is data; anything after the closing quote other than a
 * comment is refused rather than guessed at.
 */
function readValue(raw: string, label: string, lineNumber: number): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") {
    return splitUnquotedComment(raw).trim();
  }
  const close = raw.indexOf(quote, 1);
  if (close === -1) {
    throw new ConfigFileError(
      label,
      lineNumber,
      `unterminated ${quote === '"' ? "double" : "single"} quote in the value. Close the quote or remove both.`,
    );
  }
  const trailing = raw.slice(close + 1).trim();
  if (trailing.length > 0 && !trailing.startsWith("#")) {
    throw new ConfigFileError(
      label,
      lineNumber,
      "unexpected text after the closing quote. Quote the whole value or leave it unquoted.",
    );
  }
  return raw.slice(1, close);
}

/**
 * The write order for known keys, so a rewritten file diffs cleanly and the
 * secrets sit where the first-run notice points. Unknown keys follow, sorted.
 */
const SERIALIZE_ORDER = [
  "CREDENTIAL_ENCRYPTION_KEY",
  "INTERNAL_MCP_TOKEN",
  "HABENULA_PORT",
  "OAUTH_REDIRECT_BASE_URL",
];

/** Serialize variables as plain unquoted `KEY=value` lines in a fixed order. */
export function serializeEnvFile(vars: Record<string, string>): string {
  // hasOwn, not `in`: an inherited Object.prototype name (`constructor`,
  // `toString`) reads as present under `in` and would be written from the
  // prototype instead of the record, or dropped from the output entirely.
  const known = SERIALIZE_ORDER.filter((key) => Object.hasOwn(vars, key));
  const rest = Object.keys(vars)
    .filter((key) => !SERIALIZE_ORDER.includes(key))
    .sort();
  return [...known, ...rest].map((key) => `${key}=${vars[key]}\n`).join("");
}
