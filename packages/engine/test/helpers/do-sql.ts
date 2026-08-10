import { env } from "cloudflare:workers";
import type { EngineSql } from "../../src/data/helpers/types";

/** A fresh UserAgent DO stub, unique per call. */
export function getUserAgentStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

/**
 * The bound `this.sql` tagged template, obtained the same way UserAgent binds
 * it, so data-helper tests run exactly as the helpers do in production. The
 * cast is necessary because `runInDurableObject`'s callback receives the DO
 * instance typed as the class's public surface, which doesn't expose `sql`.
 */
export function bindDoSql(instance: { sql: EngineSql }): EngineSql {
  return instance.sql.bind(instance) as EngineSql;
}
