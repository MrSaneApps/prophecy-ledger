import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class D1Shim {
  constructor() { this.db = new DatabaseSync(":memory:"); this.statementCount = 0; }
  exec(sql) { this.db.exec(sql); }
  resetStatementCount() { this.statementCount = 0; }
  prepare(sql) {
    const owner = this;
    const named = sql.replace(/\?(\d+)/g, ":p$1");
    const statement = this.db.prepare(named);
    const params = (values) => Object.fromEntries(values.map((value, index) => [`p${index + 1}`, value]));
    const bound = (values) => ({
      _batchRun: () => {
        owner.statementCount += 1;
        const result = statement.run(params(values));
        return { success: true, meta: { changes: Number(result.changes || 0) } };
      },
      first: async () => { owner.statementCount += 1; return statement.get(params(values)) || null; },
      all: async () => { owner.statementCount += 1; return { results: statement.all(params(values)) }; },
      run: async () => {
        owner.statementCount += 1;
        const result = statement.run(params(values));
        return { success: true, meta: { changes: Number(result.changes || 0) } };
      },
    });
    return {
      bind: (...values) => bound(values),
      first: async () => { owner.statementCount += 1; return statement.get() || null; },
      all: async () => { owner.statementCount += 1; return { results: statement.all() }; },
      run: async () => { owner.statementCount += 1; statement.run(); return { success: true }; },
    };
  }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement._batchRun());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function makeEnv({ demo = false } = {}) {
  const env = {
    DB: new D1Shim(),
    REVIEW_DEMO_MODE: demo ? "1" : "0",
    DEMO_REVIEWER_1_ID: "reviewer_alpha",
    DEMO_REVIEWER_1_TOKEN: "alpha-token",
    DEMO_REVIEWER_2_ID: "reviewer_beta",
    DEMO_REVIEWER_2_TOKEN: "beta-token",
    DEMO_REVIEWER_3_ID: "reviewer_gamma",
    DEMO_REVIEWER_3_TOKEN: "gamma-token",
    REVIEWER_1_ID: "admin_reviewer_alpha",
    REVIEWER_1_TOKEN: "admin-alpha-token",
    REVIEWER_2_ID: "admin_reviewer_beta",
    REVIEWER_2_TOKEN: "admin-beta-token",
  };
  for (const file of readdirSync(join(ROOT, "migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    env.DB.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  env.DB.resetStatementCount();
  return env;
}

export function context({ env, url, method = "GET", body, params = {}, headers = {} }) {
  return {
    env,
    params,
    request: new Request(url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

export async function jsonBody(response) {
  return response.json();
}

export function fixture(name) {
  return JSON.parse(readFileSync(join(ROOT, "test", "fixtures", name), "utf8"));
}
