// Shared audit-chain fixtures for the `log` command tests: build real chains
// with the real hash function (@habenula-ai/audit is a devDependency), page them the
// way the route does (newest first, opaque cursor), and serve them from a
// fake client. No zod, no engine — the CLI tests run on plain vitest.
import {
  GENESIS_SENTINEL,
  computeEntryHash,
  type EntryHashFields,
} from "@habenula-ai/audit/hash";
import type { ApiClient, AuditChainEntry, AuditListResponse } from "../../src/api-client";

type Authored = Omit<EntryHashFields, "epochId" | "sequenceNum" | "prevHash">;

function authored(n: number): Authored {
  return {
    id: `entry-${String(n).padStart(5, "0")}`,
    timestamp: `2026-07-01T09:00:${String(n % 60).padStart(2, "0")}.000Z`,
    userId: "user-1",
    agentId: "agent-mail",
    sessionId: "session-1",
    origin: "human",
    service: "gmail",
    verb: "read",
    noun: "messages",
    toolName: "gmail_list_messages",
    parametersMetadata: '{"maxResults":{"type":"number"}}',
    decision: "allow",
    outcome: "success",
    errorMessage: null,
    decisionEntryId: null,
    latencyMs: 10 + n,
    costUsd: n % 5 === 0 ? 5e-7 : null,
  };
}

export interface EpochSpec {
  epochId: string;
  count: number;
}

/** Build an intact chain in ASCENDING order, the way the audit log writes it.
 * `priorEpochFinalHash` models a bounded range whose oldest epoch links to
 * history outside the fixture. `override` patches authored fields per entry
 * BEFORE hashing (the tamper helpers below patch AFTER). */
export function buildWireChain(
  spec: EpochSpec[],
  options?: {
    priorEpochFinalHash?: string | null;
    override?: (epochId: string, sequenceNum: number, fields: Authored) => Authored;
  },
): AuditChainEntry[] {
  const out: AuditChainEntry[] = [];
  let lastEpochFinalHash: string | null = options?.priorEpochFinalHash ?? null;
  let n = 0;
  for (const { epochId, count } of spec) {
    let prevHash = GENESIS_SENTINEL;
    for (let sequenceNum = 0; sequenceNum < count; sequenceNum++) {
      let fields = authored(n++);
      if (options?.override) fields = options.override(epochId, sequenceNum, fields);
      const full: EntryHashFields = { ...fields, epochId, sequenceNum, prevHash };
      const hash = computeEntryHash(full);
      out.push({ ...full, hash, epochPrevHash: sequenceNum === 0 ? lastEpochFinalHash : null });
      prevHash = hash;
    }
    lastEpochFinalHash = prevHash;
  }
  return out;
}

/** The route's order: newest first, genesis last. */
export function descending(chain: readonly AuditChainEntry[]): AuditChainEntry[] {
  return [...chain].reverse();
}

/** Slice a descending chain into route-shaped pages with opaque cursors. */
export function pagesOf(
  entriesDescending: readonly AuditChainEntry[],
  pageSize: number,
): AuditListResponse[] {
  const pages: AuditListResponse[] = [];
  for (let i = 0; i < entriesDescending.length; i += pageSize) {
    const slice = entriesDescending.slice(i, i + pageSize);
    const last = i + pageSize >= entriesDescending.length;
    pages.push({ entries: slice, nextCursor: last ? null : `cursor-${pages.length + 1}` });
  }
  if (pages.length === 0) pages.push({ entries: [], nextCursor: null });
  return pages;
}

export interface FakeAuditClient {
  client: ApiClient;
  calls: Array<{ limit?: number; cursor?: string | null }>;
}

/**
 * A fake client serving the given pages in order, keyed by the cursor chain
 * `pagesOf` mints. `onCall(index)` runs before each page is returned — tests
 * use it to abort a signal at a page boundary or to throw mid-walk.
 */
export function fakeAuditClient(
  pages: readonly AuditListResponse[],
  onCall?: (index: number) => void,
): FakeAuditClient {
  const calls: Array<{ limit?: number; cursor?: string | null }> = [];
  const client = {
    listAuditEntries: async (opts?: { limit?: number; cursor?: string | null }) => {
      const index = calls.length;
      calls.push({ ...opts });
      onCall?.(index);
      const byCursor = opts?.cursor
        ? pages.findIndex((_, i) => `cursor-${i}` === opts.cursor)
        : 0;
      const page = pages[byCursor];
      if (page === undefined) throw new Error(`fake client has no page for cursor ${opts?.cursor}`);
      return page;
    },
  } as unknown as ApiClient;
  return { client, calls };
}
