import { describe, it, expect } from "vitest";
import { ContractDescriptorsResponse } from "@habenula-ai/contracts";
import { buildContractDescriptors } from "../../src/dev-model/contract-descriptors";

/**
 * The route ↔ contract descriptor table behind `GET /api/dev/contracts`
 * is hand-maintained next to the routing, so the
 * assertions here pin the properties a drifted table would lose: every row
 * self-validates, GETs carry no request schema, POSTs carry one, and the
 * JSON Schema rendering actually describes the shape (not an empty stub).
 */
describe("buildContractDescriptors", () => {
  const body = buildContractDescriptors();

  it("validates against its own response contract", () => {
    ContractDescriptorsResponse.parse(body);
  });

  it("covers the core governed routes", () => {
    const routes = body.routes.map((r) => `${r.method} ${r.route}`);
    for (const expected of [
      "POST /api/chat",
      "POST /api/resolve",
      "GET /api/status",
      "POST /api/session/start",
      "POST /api/kill",
      "GET /api/tasks",
      "GET /api/tasks/get",
      "POST /api/tasks/cancel",
      "GET /api/audit",
      "GET /api/dev/model",
      "GET /api/dev/contracts",
    ]) {
      expect(routes).toContain(expected);
    }
  });

  it("GET routes have null request; POST routes carry a request schema (except param-only POSTs)", () => {
    // /connect/{service} is a POST whose inputs are the {service} path segment
    // and a ?userId query param — no JSON body — so its request descriptor is
    // null like a GET's. Declaring a body schema here misled clients into
    // POSTing {userId}, which the handler ignores (it reads url.searchParams),
    // silently routing to the demo-user DO. Every other POST carries a body.
    const paramOnlyPosts = new Set(["/connect/{service}"]);
    for (const r of body.routes) {
      if (r.method === "GET" || paramOnlyPosts.has(r.route)) {
        expect(r.request, r.route).toBeNull();
      } else {
        expect(r.request, r.route).not.toBeNull();
      }
    }
  });

  it("publishes the query contract of every route that reads one", () => {
    // A route takes its input one way or the other, so exactly one of the two
    // input sides is populated. The exception is the three routes that read no
    // input at all: the discovery catalog and health carry no user state, and the
    // descriptor route takes no parameters. A body route's `userId` arrives in
    // the body, which is why a POST publishing `query: null` is correct rather
    // than a gap.
    const noInput = new Set([
      "/api/services/catalog",
      "/api/health",
      "/api/dev/contracts",
    ]);
    for (const r of body.routes) {
      if (noInput.has(r.route)) {
        expect(r.query, r.route).toBeNull();
        expect(r.request, r.route).toBeNull();
      } else {
        const sides = [r.query, r.request].filter((s) => s !== null);
        expect(sides, r.route).toHaveLength(1);
      }
    }
  });

  it("publishes the required query parameters, not just userId", () => {
    // A paged read and a required-parameter read: the properties a client has to
    // send are named, so a generator no longer has to hand-maintain them.
    const props = (route: string) => {
      const row = body.routes.find((r) => r.route === route)!;
      return (row.query as { properties?: Record<string, unknown> }).properties;
    };
    expect(props("/api/audit")).toHaveProperty("cursor");
    expect(props("/api/audit")).toHaveProperty("limit");
    expect(props("/api/tasks")).toHaveProperty("cursor");
    expect(props("/api/tasks/get")).toHaveProperty("taskId");
    expect(props("/api/connect/status")).toHaveProperty("service");
    expect(props("/api/connect/status")).toHaveProperty("flow");
  });

  it("renders real JSON Schema, input side for requests", () => {
    const chat = body.routes.find((r) => r.route === "/api/chat")!;
    // Response: the strict envelope surfaces as an object schema with
    // additionalProperties pinned false.
    expect(chat.response).toMatchObject({ type: "object" });
    expect(chat.response.additionalProperties).toBe(false);
    // Request: input side — userId is describable pre-transform.
    const reqProps = (chat.request as { properties?: Record<string, unknown> })
      .properties;
    expect(reqProps).toHaveProperty("message");
    expect(reqProps).toHaveProperty("userId");

    const snapshot = body.routes.find((r) => r.route === "/api/dev/model")!;
    const respProps = (
      snapshot.response as { properties?: Record<string, unknown> }
    ).properties;
    expect(respProps).toHaveProperty("policyEntries");
    expect(respProps).toHaveProperty("audit");
    expect(respProps).toHaveProperty("tableCounts");
  });
});
