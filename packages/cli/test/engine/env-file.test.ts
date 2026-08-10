import { describe, it, expect } from "vitest";
import {
  ConfigFileError,
  parseEnvFile,
  serializeEnvFile,
} from "../../src/engine/env-file";

const LABEL = "/tmp/test/config";

describe("parseEnvFile", () => {
  it("parses plain KEY=value lines", () => {
    expect(parseEnvFile("A=1\nB=two\n", LABEL)).toEqual({ A: "1", B: "two" });
  });

  it("skips blank lines and # comments", () => {
    const text = "# a comment\n\n   \nA=1\n  # indented comment\n";
    expect(parseEnvFile(text, LABEL)).toEqual({ A: "1" });
  });

  it("trims whitespace around the key and the value", () => {
    expect(parseEnvFile("  A  =  1  \n", LABEL)).toEqual({ A: "1" });
  });

  it("tolerates a leading `export ` with any whitespace after it", () => {
    expect(parseEnvFile("export A=1\n", LABEL)).toEqual({ A: "1" });
    // A tab after `export` used to leave "export\tA" as the key, so the value
    // was stored under a name nothing reads and the secret was never seen.
    expect(parseEnvFile("export\tA=1\n", LABEL)).toEqual({ A: "1" });
    expect(parseEnvFile("export   A=1\n", LABEL)).toEqual({ A: "1" });
  });

  describe("inline comments", () => {
    it("drops a trailing comment from an unquoted value", () => {
      // A user annotating their own credential key used to glue the note onto
      // the key: the engine then derives a different AES key and every stored
      // credential fails to decrypt, as a crypto error far from this line.
      expect(
        parseEnvFile("CREDENTIAL_ENCRYPTION_KEY=3f9a  # generated\n", LABEL),
      ).toEqual({ CREDENTIAL_ENCRYPTION_KEY: "3f9a" });
      expect(parseEnvFile("HABENULA_PORT=8788 # dev\n", LABEL)).toEqual({
        HABENULA_PORT: "8788",
      });
    });

    it("keeps a # that is part of the value, as a shell would", () => {
      // `abc#def` is one word to a shell, so the hash is data. Only whitespace
      // followed by # starts a comment.
      expect(parseEnvFile("A=ab#cd\n", LABEL)).toEqual({ A: "ab#cd" });
      expect(parseEnvFile("A=#nothash\n", LABEL)).toEqual({ A: "#nothash" });
    });

    it("keeps a # inside quotes and still drops a comment after them", () => {
      expect(parseEnvFile(`A="has # inside"  # note\n`, LABEL)).toEqual({
        A: "has # inside",
      });
    });
  });

  describe("the key shape", () => {
    it("refuses a quoted key", () => {
      // The line has an `=` and a non-empty key, so it used to parse — storing
      // the token under `"INTERNAL_MCP_TOKEN"` while the CLI reported the file
      // as holding no token.
      expect(() => parseEnvFile(`"INTERNAL_MCP_TOKEN"=abc\n`, LABEL)).toThrowError(
        /line 1: `"INTERNAL_MCP_TOKEN"` is not a variable name/,
      );
    });

    it("refuses a key with a space or a leading digit", () => {
      expect(() => parseEnvFile("MY KEY=1\n", LABEL)).toThrowError(
        /is not a variable name/,
      );
      expect(() => parseEnvFile("1ST=1\n", LABEL)).toThrowError(
        /is not a variable name/,
      );
    });

    it("accepts the shapes a real env file uses", () => {
      expect(parseEnvFile("_A=1\nB_2=2\nlower=3\n", LABEL)).toEqual({
        _A: "1",
        B_2: "2",
        lower: "3",
      });
    });
  });

  it("stores __proto__ as an ordinary key rather than dropping it", () => {
    // On a plain object this assignment hits the prototype setter and stores
    // nothing: a line reported as parsed and silently dropped, which is the one
    // outcome the refusals exist to rule out.
    const vars = parseEnvFile("__proto__=surprise\nA=1\n", LABEL);
    expect(vars.__proto__).toBe("surprise");
    expect(Object.keys(vars).sort()).toEqual(["A", "__proto__"]);
  });

  it("does not report inherited Object.prototype names as present", () => {
    const vars = parseEnvFile("A=1\n", LABEL);
    expect(Object.hasOwn(vars, "constructor")).toBe(false);
    expect(vars.toString).toBeUndefined();
  });

  it("strips one matching pair of surrounding quotes, single or double", () => {
    expect(parseEnvFile(`A="quoted value"\nB='single'\n`, LABEL)).toEqual({
      A: "quoted value",
      B: "single",
    });
  });

  it("keeps a quote inside an unquoted value", () => {
    expect(parseEnvFile(`B=mid"dle\n`, LABEL)).toEqual({ B: `mid"dle` });
  });

  it("refuses an unterminated quote instead of keeping it as data", () => {
    // The old reading kept `"half` verbatim. A shell sourcing the same line
    // would swallow the following lines into the value, so the two readings
    // disagree about a file that holds secrets — refuse rather than pick one.
    expect(() => parseEnvFile(`A="half\n`, LABEL)).toThrowError(
      /line 1: unterminated double quote/,
    );
  });

  it("refuses text after a closing quote", () => {
    expect(() => parseEnvFile(`A="one" two\n`, LABEL)).toThrowError(
      /line 1: unexpected text after the closing quote/,
    );
  });

  it("splits at the first = only", () => {
    expect(parseEnvFile("A=b=c=d\n", LABEL)).toEqual({ A: "b=c=d" });
  });

  it("interpolates nothing and honours no escapes", () => {
    expect(parseEnvFile("A=${HOME}\\n\n", LABEL)).toEqual({ A: "${HOME}\\n" });
  });

  it("keeps the last value for a duplicate key, like a sourced file", () => {
    expect(parseEnvFile("A=1\nA=2\n", LABEL)).toEqual({ A: "2" });
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n", LABEL)).toEqual({ A: "1", B: "2" });
  });

  it("refuses a line with no =, naming the file and the one-based line number", () => {
    let thrown: unknown;
    try {
      parseEnvFile("A=1\njust some words\n", LABEL);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigFileError);
    const err = thrown as ConfigFileError;
    expect(err.label).toBe(LABEL);
    expect(err.lineNumber).toBe(2);
    expect(err.message).toContain(LABEL);
    expect(err.message).toContain("line 2");
    expect(err.message).toContain("KEY=value");
  });

  it("refuses an empty key", () => {
    expect(() => parseEnvFile("=value\n", LABEL)).toThrow(ConfigFileError);
  });

  it.each([
    "HABENULA_CONFIG",
    "HABENULA_PERSIST_ROOT",
    "HABENULA_API_URL",
    "HABENULA_INTERNAL_MCP_URL",
  ])(
    "refuses %s by name and says to export it instead",
    (variable) => {
      let thrown: unknown;
      try {
        parseEnvFile(`${variable}=/somewhere\n`, LABEL);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfigFileError);
      const err = thrown as ConfigFileError;
      expect(err.message).toContain(variable);
      expect(err.message.toLowerCase()).toContain("export");
      expect(err.lineNumber).toBe(1);
    },
  );

  it("refuses the path variables even under an export prefix or quotes", () => {
    expect(() => parseEnvFile("export HABENULA_CONFIG='/x'\n", LABEL)).toThrow(
      ConfigFileError,
    );
  });

  it("says the URLs are not read from the file, not that they are circular", () => {
    // The two path variables decide which file this is; the two URLs are simply
    // env-only. A user who writes one needs to know where it is read instead.
    expect(() =>
      parseEnvFile("HABENULA_API_URL=http://localhost:9000\n", LABEL),
    ).toThrowError(/is not read from this file.*derives from HABENULA_PORT/s);
  });
});

describe("serializeEnvFile", () => {
  it("writes plain unquoted KEY=value lines", () => {
    expect(serializeEnvFile({ A: "1" })).toBe("A=1\n");
  });

  it("writes keys in a fixed order so a rewritten file diffs cleanly", () => {
    const text = serializeEnvFile({
      ZED: "z",
      HABENULA_PORT: "8788",
      ANTHROPIC_API_KEY: "sk-x",
      CREDENTIAL_ENCRYPTION_KEY: "k",
      OAUTH_REDIRECT_BASE_URL: "http://localhost:8788",
      INTERNAL_MCP_TOKEN: "t",
    });
    expect(text).toBe(
      [
        "CREDENTIAL_ENCRYPTION_KEY=k",
        "INTERNAL_MCP_TOKEN=t",
        "HABENULA_PORT=8788",
        "OAUTH_REDIRECT_BASE_URL=http://localhost:8788",
        "ANTHROPIC_API_KEY=sk-x",
        "ZED=z",
        "",
      ].join("\n"),
    );
  });

  it("round-trips through the parser", () => {
    const vars = { A: "1", B: "two words", HABENULA_PORT: "8788" };
    expect(parseEnvFile(serializeEnvFile(vars), LABEL)).toEqual(vars);
  });
});
