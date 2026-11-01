import { describe, it, expect } from "vitest";
import { ifNoTable, isMissingTable } from "./missing-table";

/** An error shaped like the ones postgres.js and the Neon driver throw. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("ifNoTable (#765)", () => {
  it("passes the rows through when the read works", async () => {
    expect(await Promise.resolve([{ n: 1 }]).catch(ifNoTable([]))).toEqual([{ n: 1 }]);
  });

  it("answers the fallback when the table does not exist yet", async () => {
    const missing = pgError("42P01", 'relation "synced_workouts" does not exist');
    expect(await Promise.reject(missing).catch(ifNoTable([]))).toEqual([]);
  });

  it("throws when the database does not answer, so it never reads as an empty account", async () => {
    const quota = pgError("XX000", "Your account or project has exceeded the quota");
    await expect(Promise.reject(quota).catch(ifNoTable([]))).rejects.toBe(quota);
    const refused = pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432");
    await expect(Promise.reject(refused).catch(ifNoTable([]))).rejects.toBe(refused);
  });

  it("does not take a message that only mentions a missing table for the real code", () => {
    expect(isMissingTable(new Error('relation "x" does not exist'))).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});
