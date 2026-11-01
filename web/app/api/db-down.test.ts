import { describe, it, expect, vi, beforeEach } from "vitest";

// Every read the routes make goes through this one fake, which fails the way it is told to.
const db = vi.hoisted(() => ({ fail: null as null | { code: string; message: string } }));
vi.mock("@/lib/db", () => {
  const sql = () =>
    db.fail ? Promise.reject(Object.assign(new Error(db.fail.message), { code: db.fail.code })) : Promise.resolve([]);
  return { getDb: () => sql };
});

import { GET as status } from "./hevy/status/route";
import { GET as workouts } from "./workouts/route";
import { GET as mappings } from "./mappings/route";

const routes = { "/api/hevy/status": status, "/api/workouts": workouts, "/api/mappings": mappings };

beforeEach(() => { db.fail = null; vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("read APIs when the database does not answer (#765)", () => {
  for (const [path, GET] of Object.entries(routes)) {
    it(`${path} answers 503 and says so, rather than 200 with an empty account`, async () => {
      db.fail = { code: "XX000", message: "Your account or project has exceeded the quota" };
      const res = await GET();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "The database is not answering. Try again later." });
    });

    it(`${path} still answers 200 on a fresh install whose tables do not exist yet`, async () => {
      db.fail = { code: "42P01", message: 'relation "synced_workouts" does not exist' };
      expect((await GET()).status).toBe(200);
    });
  }
});
