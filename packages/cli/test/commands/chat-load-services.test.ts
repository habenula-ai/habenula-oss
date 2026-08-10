import { describe, expect, it, vi } from "vitest";
import type { ServicesResponse } from "@habenula-ai/contracts";
import { ApiClient } from "../../src/api-client";
import { loadServices, serviceSourceCell, type ServiceLoad } from "../../src/commands/chat";

/**
 * `loadServices` seeds the REPL's `:connect`/`:disconnect` completion sources.
 * The two are independent endpoints — `getCatalog` feeds `:connect`,
 * `listServices` feeds `:disconnect` — and must degrade independently: a
 * failure of one may not empty the other. A prior `Promise.all` coupled them,
 * so a transient `listServices` rejection silently killed `:connect` completion
 * for the whole session even though the catalog fetch had succeeded.
 */
function stub(overrides: Partial<Record<string, unknown>> = {}): ApiClient {
  return {
    getCatalog: vi.fn(async () => ({
      services: [{ service: "gmail" }, { service: "mock_email" }, { service: "slack" }],
    })),
    ...overrides,
  } as unknown as ApiClient;
}

const connected = (services: ServicesResponse["services"]): Promise<ServicesResponse> =>
  Promise.resolve({ services });

describe("loadServices completion sources", () => {
  it("populates both when both reads succeed", async () => {
    const src = await loadServices(stub(), connected([{ service: "gmail", connected_at: "x" }]));
    expect(src.connectable).toEqual(["gmail", "mock_email", "slack"]);
    expect(src.connected).toEqual(["gmail"]);
  });

  it("keeps the connectable catalog when the connected read fails", async () => {
    // The regression: a rejected connectedOnce must NOT empty `connectable`.
    const rejected = Promise.reject(new Error("engine momentarily down"));
    rejected.catch(() => {}); // match the boot read's unhandled-rejection guard
    const src = await loadServices(stub(), rejected);
    expect(src.connectable).toEqual(["gmail", "mock_email", "slack"]);
    expect(src.connected).toBeNull();
  });

  it("keeps the connected set when the catalog read fails", async () => {
    const src = await loadServices(
      stub({ getCatalog: vi.fn(async () => Promise.reject(new Error("catalog down"))) }),
      connected([{ service: "slack", connected_at: "x" }]),
    );
    expect(src.connectable).toBeNull();
    expect(src.connected).toEqual(["slack"]);
  });

 it("reports both sources failed (null) when both reads fail", async () => {
    // `null` — nothing learned — not `[]`: the cell keeps that source's
    // last-known completions, so a refresh against an unreachable Worker
    // degrades to stale completions instead of wiping them.
    const rejected = Promise.reject(new Error("down"));
    rejected.catch(() => {});
    const src = await loadServices(
      stub({ getCatalog: vi.fn(async () => Promise.reject(new Error("down"))) }),
      rejected,
    );
    expect(src.connectable).toBeNull();
    expect(src.connected).toBeNull();
  });

  it("reports a successful empty read as [], not null (disconnect of the only service)", async () => {
    // Genuinely-empty must not be mistaken for failure: after `:disconnect` of
    // the only connected service, the fresh read returns [] and must overwrite
    // the stale `connected` set in the cell, not preserve it.
    const src = await loadServices(stub(), connected([]));
    expect(src.connectable).toEqual(["gmail", "mock_email", "slack"]);
    expect(src.connected).toEqual([]);
  });
});

/** Let already-settled seed promises run their `.then` before asserting. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("serviceSourceCell per-source freshness", () => {
  it("applies seeds that settle in issue order", async () => {
    const cell = serviceSourceCell();
    expect(cell.get()).toEqual({ connectable: [], connected: [] });
    cell.seed(Promise.resolve({ connectable: ["gmail"], connected: [] }));
    await flush();
    cell.seed(Promise.resolve({ connectable: ["gmail"], connected: ["gmail"] }));
    await flush();
    expect(cell.get()).toEqual({ connectable: ["gmail"], connected: ["gmail"] });
  });

  it("a stale earlier load cannot clobber a fresher refresh", async () => {
    // The boot-vs-refresh race: the boot read hangs (slow catalog fetch), a
    // mid-session refresh lands with the post-connect set, then the boot read
    // finally settles with its pre-connect snapshot. Latest-issued wins — the
    // boot result is discarded, not applied last-write-wins.
    const cell = serviceSourceCell();
    let resolveBoot!: (s: ServiceLoad) => void;
    cell.seed(
      new Promise<ServiceLoad>((r) => {
        resolveBoot = r;
      }),
    );
    cell.seed(Promise.resolve({ connectable: ["gmail"], connected: ["gmail"] }));
    await flush();
    expect(cell.get().connected).toEqual(["gmail"]);
    resolveBoot({ connectable: ["gmail"], connected: [] });
    await flush();
    expect(cell.get().connected).toEqual(["gmail"]);
  });

  it("a late boot read still lands a source the fresher refresh failed to load", async () => {
    // Freshness is per source, not per load: the boot read hangs, an early
    // refresh (the first-run-nudge `:connect`) lands the connected set but its
    // catalog read fails (null). The boot catalog is still the newest
    // SUCCESSFUL catalog read, so when it settles it must land — a per-load
    // stamp would discard it and leave `:connect` completion empty for the
    // session.
    const cell = serviceSourceCell();
    let resolveBoot!: (s: ServiceLoad) => void;
    cell.seed(
      new Promise<ServiceLoad>((r) => {
        resolveBoot = r;
      }),
    );
    cell.seed(Promise.resolve({ connectable: null, connected: ["mock_email"] }));
    await flush();
    expect(cell.get()).toEqual({ connectable: [], connected: ["mock_email"] });
    resolveBoot({ connectable: ["gmail", "mock_email"], connected: [] });
    await flush();
    // Boot's catalog lands (newest successful read); boot's pre-connect
    // connected set stays discarded (the refresh landed a newer one).
    expect(cell.get()).toEqual({ connectable: ["gmail", "mock_email"], connected: ["mock_email"] });
  });

  it("a null source keeps the last-known set; a successful empty read overwrites it", async () => {
    const cell = serviceSourceCell();
    cell.seed(Promise.resolve({ connectable: ["gmail", "slack"], connected: ["gmail"] }));
    await flush();
    cell.seed(Promise.resolve({ connectable: null, connected: null }));
    await flush();
    expect(cell.get()).toEqual({ connectable: ["gmail", "slack"], connected: ["gmail"] });
    cell.seed(Promise.resolve({ connectable: null, connected: [] }));
    await flush();
    expect(cell.get()).toEqual({ connectable: ["gmail", "slack"], connected: [] });
  });

  it("a rejected load degrades like a wholly-failed read instead of rejecting unhandled", async () => {
    // Belt-and-braces: `loadServices` settles per-source failures to nulls and
    // never rejects, but the cell must not turn a rejecting load into an
    // unhandled rejection — it applies nothing and keeps the current sets.
    const cell = serviceSourceCell();
    cell.seed(Promise.resolve({ connectable: ["gmail"], connected: ["gmail"] }));
    await flush();
    cell.seed(Promise.reject(new Error("down")));
    await flush();
    expect(cell.get()).toEqual({ connectable: ["gmail"], connected: ["gmail"] });
  });
});
