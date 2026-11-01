import { describe, it, expect, afterEach } from "vitest";
import { loadGarminConnection, loadHevyConnection } from "./connections";

type Sql = Parameters<typeof loadGarminConnection>[0];

/** A fake `sql` tag that records the query text and returns a canned result set. */
function fakeSql(rows: unknown[], sink?: string[]): Sql {
  const tag = (async (strings: TemplateStringsArray) => {
    sink?.push(strings.join("?").replace(/\s+/g, " ").trim());
    return rows;
  }) as unknown as Sql;
  return tag;
}

function throwingSql(): Sql {
  return (async () => {
    throw Object.assign(new Error("relation \"platform_credentials\" does not exist"), { code: "42P01" });
  }) as unknown as Sql;
}

/** A database that does not answer at all, which must never read as "not connected" (#765). */
function downSql(): Sql {
  return (async () => {
    throw Object.assign(new Error("Your account or project has exceeded the quota"), { code: "XX000" });
  }) as unknown as Sql;
}

describe("loadGarminConnection (#495)", () => {
  it("reads the garmin_tokens row, not the garmin email/password row", async () => {
    const queries: string[] = [];
    await loadGarminConnection(fakeSql([], queries));
    expect(queries[0]).toContain("WHERE platform = 'garmin_tokens'");
    expect(queries[0]).not.toContain("'garmin'");
  });

  it("is connected when a nested DI token is stored, ignoring the status column", async () => {
    // has_token is what the SQL computes; status is deliberately absent from the projection
    // because DBTokenStore's DO UPDATE never refreshes it.
    const r = await loadGarminConnection(
      fakeSql([{ connected_at: "2026-09-01T00:00:00Z", has_token: true }]),
    );
    expect(r).toEqual({ connected: true, connectedAt: "2026-09-01T00:00:00Z" });
  });

  it("accepts a token with no connected_at, which the token-store upsert never sets", async () => {
    const r = await loadGarminConnection(fakeSql([{ connected_at: null, has_token: true }]));
    expect(r).toEqual({ connected: true, connectedAt: null });
  });

  it("tests both the nested and the flat token shape", async () => {
    const queries: string[] = [];
    await loadGarminConnection(fakeSql([], queries));
    expect(queries[0]).toContain("jsonb_exists(credentials -> 'garmin_tokens', 'di_token')");
    expect(queries[0]).toContain("jsonb_exists(credentials, 'di_token')");
  });

  it("is disconnected when the row exists but holds no token", async () => {
    const r = await loadGarminConnection(
      fakeSql([{ connected_at: "2026-09-01T00:00:00Z", has_token: false }]),
    );
    expect(r).toEqual({ connected: false, connectedAt: null });
  });

  it("is disconnected when no row exists at all", async () => {
    expect(await loadGarminConnection(fakeSql([]))).toEqual({
      connected: false,
      connectedAt: null,
    });
  });

  it("degrades to disconnected when the table is missing", async () => {
    expect(await loadGarminConnection(throwingSql())).toEqual({
      connected: false,
      connectedAt: null,
    });
  });
});

describe("loadHevyConnection", () => {
  it("treats the status the setup form actually writes as connected", async () => {
    const r = await loadHevyConnection(
      fakeSql([{ status: "active", connected_at: "2026-09-01T00:00:00Z", has_key: true }]),
    );
    expect(r).toEqual({ connected: true, connectedAt: "2026-09-01T00:00:00Z" });
  });

  it("treats an explicit disconnected status as disconnected", async () => {
    const r = await loadHevyConnection(fakeSql([{ status: "disconnected", connected_at: null }]));
    expect(r.connected).toBe(false);
  });

  it("is disconnected when no row exists", async () => {
    expect((await loadHevyConnection(fakeSql([]))).connected).toBe(false);
  });

  it("degrades to disconnected when the table is missing", async () => {
    expect((await loadHevyConnection(throwingSql())).connected).toBe(false);
  });

  describe("a key from HEVY_API_KEY", () => {
    const ENV = process.env.HEVY_API_KEY;
    afterEach(() => {
      if (ENV === undefined) delete process.env.HEVY_API_KEY;
      else process.env.HEVY_API_KEY = ENV;
    });

    it("is connected without any row, as the sync uses it", async () => {
      process.env.HEVY_API_KEY = "k";
      expect(await loadHevyConnection(fakeSql([]))).toEqual({ connected: true, connectedAt: null });
    });

    it("is still disconnected once Hevy rejected it", async () => {
      process.env.HEVY_API_KEY = "k";
      const r = await loadHevyConnection(fakeSql([{ status: "disconnected", connected_at: null, has_key: false }]));
      expect(r.connected).toBe(false);
    });

    it("a status-only row without the env key is not a connection", async () => {
      delete process.env.HEVY_API_KEY;
      const r = await loadHevyConnection(fakeSql([{ status: "active", connected_at: null, has_key: false }]));
      expect(r.connected).toBe(false);
    });
  });
});

describe("a database that does not answer (#765)", () => {
  it("is thrown rather than read as disconnected", async () => {
    await expect(loadGarminConnection(downSql())).rejects.toThrow("exceeded the quota");
    await expect(loadHevyConnection(downSql())).rejects.toThrow("exceeded the quota");
  });
});
