/**
 * The zod-authoring half of the spike gate.
 *
 * The MCP SDK resolves its own nested zod v3 (`zod-to-json-schema` forces it);
 * the engine pins zod 4.4.3. Tool input schemas cross that seam: whichever
 * copy authors them must survive the SDK's serialization (tools/list) and
 * validation (tools/call). The spike's empirical finding, pinned here: the
 * SDK's runtime zod-compat layer accepts engine-v4 schemas, but its TYPES are
 * v3-shaped — engine-v4 shapes fail `tsc` at `registerTool`. So tool schemas
 * are authored with the SDK's zod major via the pinned `zod-mcp` alias
 * (`npm:zod@3.25.76`, the same version the SDK's nested copy resolves), which
 * typechecks AND validates. This test exercises serialization (tools/list)
 * and both validation paths (tools/call) through the exact authoring import
 * The real commission schemas use.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod-mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function connectedPair(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "authoring-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("tool schemas authored via the zod-mcp alias (the SDK's zod major)", () => {
  it("serializes to JSON schema in tools/list and validates on tools/call", async () => {
    const server = new McpServer({ name: "probe", version: "0" });
    server.registerTool(
      "probe_commission",
      {
        description: "authoring probe",
        inputSchema: {
          goal: z.string().min(1).max(4000),
          data: z.record(z.string()).optional(),
        },
      },
      ({ goal, data }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ goal, keys: Object.keys(data ?? {}) }),
          },
        ],
      }),
    );
    const client = await connectedPair(server);

    // Serialization: the declared shape must reach the wire as JSON schema.
    const listed = await client.listTools();
    const input = listed.tools[0]!.inputSchema as {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties ?? {})).toEqual(
      expect.arrayContaining(["goal", "data"]),
    );
    expect(input.required).toEqual(["goal"]);

    // Validation, accept path: a conforming call reaches the handler.
    const ok = await client.callTool({
      name: "probe_commission",
      arguments: { goal: "hello", data: { recipient: "a@b.c" } },
    });
    expect(JSON.parse((ok.content as { text: string }[])[0]!.text)).toEqual({
      goal: "hello",
      keys: ["recipient"],
    });

    // Validation, reject path: a violating call must NOT reach the handler —
    // this is the boundary the data-map key validation will stand on.
    const bad = await client.callTool(
      { name: "probe_commission", arguments: { goal: "" } },
      undefined,
    );
    expect(bad.isError).toBe(true);
  });
});
