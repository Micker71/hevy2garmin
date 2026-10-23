import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/update-check — the dashboard's update banner (#749). It never
 * fails the page: nothing to check, the database or GitHub failing, all
 * answer 200 with no banner. The GitHub token is never in the answer.
 */

const TOKEN = "ghp_secret_token_value";
const DEPLOYED = "a".repeat(40);
const UPSTREAM_SHA = "b".repeat(40);

const state: { pat: string | null; cache: unknown; failure: unknown; dbDown: boolean } = { pat: null, cache: undefined, failure: undefined, dbDown: false };
const queries: string[] = [];
vi.mock("@/lib/db", () => {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    queries.push(q);
    if (q.includes("FROM platform_credentials")) return Promise.resolve(state.pat ? [{ credentials: { pat: state.pat } }] : []);
    const slot = values[0] === "update_check_failure" ? "failure" : "cache";
    if (/^\s*SELECT value FROM app_cache/.test(q)) return Promise.resolve(state[slot] === undefined ? [] : [{ value: state[slot] }]);
    if (/^\s*INSERT INTO app_cache/.test(q)) {
      state[slot] = values[1];
      return Promise.resolve([]);
    }
    return Promise.reject(new Error("unexpected query: " + q));
  }) as unknown as { json: (v: unknown) => unknown };
  tag.json = (v) => v;
  return {
    getDb: () => {
      if (state.dbDown) throw new Error("DATABASE_URL is not set");
      return tag;
    },
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { GET } from "./route";

const ENV = ["H2G_UPDATE_CHECK", "H2G_UPSTREAM_REPO", "DEMO_MODE", "VERCEL", "VERCEL_GIT_COMMIT_SHA", "HEVY2GARMIN_COMMIT_SHA", "GITHUB_REPO", "GITHUB_PAT", "VERCEL_GIT_REPO_OWNER", "VERCEL_GIT_REPO_SLUG"];
const saved: Record<string, string | undefined> = {};

/** GitHub says upstream main is UPSTREAM_SHA, `behind` commits ahead of the deployment. */
function githubBehindBy(behind: number) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/commits/main")) return new Response(UPSTREAM_SHA);
    if (url.includes("/compare/")) {
      return new Response(JSON.stringify({ status: "ahead", ahead_by: behind, merge_base_commit: { commit: { committer: { date: "2026-10-01T00:00:00Z" } } } }));
    }
    return new Response("{}", { status: 404 });
  });
}

async function get() {
  const res = await GET();
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as { banner: Record<string, unknown> | null } };
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VERCEL = "1";
  process.env.VERCEL_GIT_COMMIT_SHA = DEPLOYED;
  process.env.VERCEL_GIT_REPO_OWNER = "someone";
  process.env.VERCEL_GIT_REPO_SLUG = "hevy2garmin";
  state.pat = null;
  state.cache = undefined;
  state.failure = undefined;
  state.dbDown = false;
  queries.length = 0;
  fetchMock.mockReset();
  githubBehindBy(3);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("GET /api/update-check", () => {
  it("a fork behind upstream gets the banner, with Update now when a token is saved", async () => {
    state.pat = TOKEN;
    const { status, body, text } = await get();
    expect(status).toBe(200);
    expect(body.banner).toMatchObject({ kind: "behind", behindBy: 3, upstreamSha: UPSTREAM_SHA, canUpdate: true });
    expect(text).not.toContain(TOKEN);
  });

  it("no Update now without a saved token", async () => {
    const { body } = await get();
    expect(body.banner).toMatchObject({ kind: "behind", canUpdate: false });
  });

  it("no Update now self-hosted, even with a token", async () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.HEVY2GARMIN_COMMIT_SHA = DEPLOYED;
    process.env.GITHUB_REPO = "someone/hevy2garmin";
    state.pat = TOKEN;
    const { body } = await get();
    expect(body.banner).toMatchObject({ kind: "behind", canUpdate: false });
  });

  it("no banner when up to date", async () => {
    githubBehindBy(0);
    expect((await get()).body.banner).toBeNull();
  });

  it.each([
    ["turned off", () => { process.env.H2G_UPDATE_CHECK = "off"; }],
    ["the demo", () => { process.env.DEMO_MODE = "true"; }],
    ["no deployed commit", () => { delete process.env.VERCEL_GIT_COMMIT_SHA; }],
    ["no fork repo", () => { delete process.env.VERCEL_GIT_REPO_OWNER; }],
    ["the upstream repo itself", () => { process.env.VERCEL_GIT_REPO_OWNER = "drkostas"; }],
  ])("%s: no banner, no database read and no GitHub call", async (_name, arrange) => {
    arrange();
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ banner: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it("GitHub failing: no banner, not an error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.banner).toBeNull();
  });

  it("GitHub failing: the next view asks GitHub nothing, and still shows no banner", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await get();
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.banner).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("GitHub failing after a good check: the good result is kept as it was", async () => {
    await get();
    const good = state.cache as Record<string, unknown>;
    good.checkedAt = new Date(Date.now() - 7 * 3600_000).toISOString();
    const before = { ...good };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    expect((await get()).body.banner).toBeNull();
    expect(state.cache).toEqual(before);
    expect(state.failure).toMatchObject({ until: expect.any(String) });
  });

  it("the database failing: no banner, not an error", async () => {
    state.dbDown = true;
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.banner).toBeNull();
  });

  it("a second view inside the cache window asks GitHub nothing", async () => {
    await get();
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const { body } = await get();
    expect(body.banner).toMatchObject({ behindBy: 3 });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("no banner while an Update now is on its way", async () => {
    await get();
    (state.cache as Record<string, unknown>).status = "updating";
    expect((await get()).body.banner).toBeNull();
  });
});
