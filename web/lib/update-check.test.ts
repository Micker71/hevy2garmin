import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  updateTarget,
  readUpdateCheck,
  bannerFor,
  markUpdating,
  recheckAfterInSync,
  syncFork,
  UPDATE_CACHE_KEY,
  UPDATE_FAILURE_KEY,
  type UpdateCheck,
  type UpdateTarget,
} from "./update-check";

/**
 * The dashboard's "update available" check (#749): whether a fork's deployed
 * commit is behind upstream `main`, cached in `app_cache`, and the fork sync
 * behind **Update now**. Every failure means no banner, never an error.
 */

const DEPLOYED = "a".repeat(40);
const UPSTREAM_SHA = "b".repeat(40);
const TOKEN = "ghp_secret_token_value";

const ENV_KEYS = [
  "H2G_UPDATE_CHECK",
  "H2G_UPSTREAM_REPO",
  "DEMO_MODE",
  "VERCEL",
  "VERCEL_GIT_COMMIT_SHA",
  "HEVY2GARMIN_COMMIT_SHA",
  "GITHUB_REPO",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_SLUG",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VERCEL_GIT_COMMIT_SHA = DEPLOYED;
  process.env.VERCEL_GIT_REPO_OWNER = "someone";
  process.env.VERCEL_GIT_REPO_SLUG = "hevy2garmin";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A fake GitHub: answers by "METHOD path", records every call with its headers. */
function fakeGithub(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const path = String(url).replace("https://api.github.com/", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return route();
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers });
const sha = (value: string) => () => new Response(value, { status: 200 });

/** Upstream main is at UPSTREAM_SHA, and the compare answers `compare`. */
function upstreamWith(compare: () => Response, upstream = "drkostas/hevy2garmin") {
  return fakeGithub({
    [`GET repos/${upstream}/commits/main`]: sha(UPSTREAM_SHA),
    [`GET repos/${upstream}/compare/${DEPLOYED}...${UPSTREAM_SHA}`]: compare,
  });
}
const compared = (status: string, aheadBy: number, mergeBaseDate = "2026-10-01T10:00:00Z") =>
  json({ status, ahead_by: aheadBy, behind_by: 0, merge_base_commit: { sha: "d".repeat(40), commit: { committer: { date: mergeBaseDate } } } });

/**
 * A fake `app_cache` with the check's two keys: `value`/`writes` for the
 * result, `failure`/`failureWrites` for a cached failure.
 */
function fakeSql(initial?: unknown, failure?: unknown) {
  const state = { value: initial as unknown, writes: 0, failure: failure as unknown, failureWrites: 0 };
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    queries.push(text);
    const key = values[0];
    expect([UPDATE_CACHE_KEY, UPDATE_FAILURE_KEY]).toContain(key);
    if (/^\s*SELECT/.test(text)) {
      const v = key === UPDATE_CACHE_KEY ? state.value : state.failure;
      return Promise.resolve(v === undefined ? [] : [{ value: v }]);
    }
    if (/^\s*INSERT INTO app_cache/.test(text)) {
      if (key === UPDATE_CACHE_KEY) {
        state.value = values[1];
        state.writes++;
      } else {
        state.failure = values[1];
        state.failureWrites++;
      }
      return Promise.resolve([]);
    }
    throw new Error("unexpected query: " + text);
  }) as never;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, state, queries };
}

const NOW = Date.parse("2026-10-19T12:00:00Z");
const target = (): UpdateTarget => updateTarget()!;
const cached = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  checkedAt: new Date(NOW - 60 * 60_000).toISOString(),
  upstream: "drkostas/hevy2garmin",
  deployedSha: DEPLOYED,
  upstreamSha: UPSTREAM_SHA,
  behindBy: 3,
  status: "behind",
  ...over,
});

describe("updateTarget: when there is nothing to check", () => {
  it("is the fork, the deployed commit and the default upstream on a Vercel fork", () => {
    expect(updateTarget()).toEqual({ upstream: "drkostas/hevy2garmin", fork: "someone/hevy2garmin", deployedSha: DEPLOYED });
  });

  it("reads H2G_UPSTREAM_REPO, HEVY2GARMIN_COMMIT_SHA and GITHUB_REPO when set", () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.HEVY2GARMIN_COMMIT_SHA = DEPLOYED;
    process.env.GITHUB_REPO = "me/h2g";
    process.env.H2G_UPSTREAM_REPO = "other/h2g";
    expect(updateTarget()).toEqual({ upstream: "other/h2g", fork: "me/h2g", deployedSha: DEPLOYED });
  });

  it.each(["off", "OFF", "false", "0", "no"])("is null when H2G_UPDATE_CHECK=%s", (v) => {
    process.env.H2G_UPDATE_CHECK = v;
    expect(updateTarget()).toBeNull();
  });

  it("is null in demo mode", () => {
    process.env.DEMO_MODE = "true";
    expect(updateTarget()).toBeNull();
  });

  it("is null without a deployed commit", () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect(updateTarget()).toBeNull();
  });

  it("is null without a fork repo", () => {
    delete process.env.VERCEL_GIT_REPO_OWNER;
    delete process.env.VERCEL_GIT_REPO_SLUG;
    expect(updateTarget()).toBeNull();
  });

  it("is null when the deployment is the upstream repo itself, whatever the case", () => {
    process.env.VERCEL_GIT_REPO_OWNER = "DrKostas";
    expect(updateTarget()).toBeNull();
  });
});

describe("readUpdateCheck: the compare", () => {
  async function check(github: ReturnType<typeof fakeGithub>, pat: string | null = null, initial?: unknown) {
    const db = fakeSql(initial);
    const result = await readUpdateCheck(db.sql, target(), pat, { fetchImpl: github.fetchImpl, now: NOW });
    return { result, db };
  }

  it("behind by N: upstream main is ahead of the deployed commit", async () => {
    const { result, db } = await check(upstreamWith(compared("ahead", 4)));
    expect(result).toMatchObject({ status: "behind", behindBy: 4, upstreamSha: UPSTREAM_SHA, deployedSha: DEPLOYED });
    expect(db.state.value).toEqual({ ...result, checkedAt: new Date(NOW).toISOString() });
  });

  it("up to date when identical", async () => {
    const { result } = await check(upstreamWith(compared("identical", 0)));
    expect(result).toMatchObject({ status: "current", behindBy: 0 });
  });

  it("up to date when the fork is ahead of upstream", async () => {
    const { result } = await check(upstreamWith(compared("behind", 0)));
    expect(result).toMatchObject({ status: "current", behindBy: 0 });
  });

  it("a fork with commits of its own on today's history counts upstream's new commits", async () => {
    const { result } = await check(upstreamWith(compared("diverged", 2, "2026-10-13T07:42:05Z")));
    expect(result).toMatchObject({ status: "behind", behindBy: 2 });
  });

  it("a fork from before the history rewrite (merge base in the shared prefix) has no count", async () => {
    const { result } = await check(upstreamWith(compared("diverged", 775, "2026-04-04T20:36:42Z")));
    expect(result).toMatchObject({ status: "rewritten", behindBy: 0, upstreamSha: UPSTREAM_SHA });
  });

  it("the rewrite boundary applies only to the default upstream", async () => {
    process.env.H2G_UPSTREAM_REPO = "other/h2g";
    const { result } = await check(upstreamWith(compared("diverged", 7, "2026-04-01T00:00:00Z"), "other/h2g"));
    expect(result).toMatchObject({ status: "behind", behindBy: 7 });
  });

  it("no common ancestor (a 404 that says so) is the count-less case, not a failure", async () => {
    const { result } = await check(
      upstreamWith(json({ message: `No common ancestor between ${DEPLOYED} and ${UPSTREAM_SHA}.` }, 404)),
    );
    expect(result).toMatchObject({ status: "rewritten", behindBy: 0 });
  });

  it("a compare with no merge base is the count-less case too", async () => {
    const { result } = await check(upstreamWith(json({ status: "diverged", ahead_by: 9, behind_by: 3 })));
    expect(result).toMatchObject({ status: "rewritten", behindBy: 0 });
  });

  it("uses the saved token when there is one, unauthenticated otherwise", async () => {
    const withToken = upstreamWith(compared("ahead", 1));
    await check(withToken, TOKEN);
    expect(withToken.calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);

    const without = upstreamWith(compared("ahead", 1));
    await check(without, null);
    expect(without.calls.every((c) => !("Authorization" in c.headers))).toBe(true);
  });

  it.each([
    ["a plain 404 (the deployed commit is unknown)", () => upstreamWith(json({ message: "Not Found" }, 404))],
    ["a 403 (rate limited)", () => upstreamWith(json({ message: "API rate limit exceeded" }, 403))],
    ["a 500", () => upstreamWith(json({}, 500))],
    ["an unknown compare status", () => upstreamWith(json({ status: "weird", ahead_by: 1, merge_base_commit: { sha: "d" } }))],
    ["upstream main not readable", () => fakeGithub({})],
    ["upstream main not a sha", () => fakeGithub({ "GET repos/drkostas/hevy2garmin/commits/main": sha("<html>") })],
    ["the network failing", () => ({ calls: [], fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })],
  ])("%s means no result, the cached result is left as it was, and the failure is cached", async (_name, make) => {
    const before = cached({ checkedAt: new Date(NOW - 7 * 3600_000).toISOString() });
    const { result, db } = await check(make() as ReturnType<typeof fakeGithub>, null, before);
    expect(result).toBeNull();
    expect(db.state.writes).toBe(0);
    expect(db.state.value).toEqual(before);
    expect(db.state.failureWrites).toBe(1);
  });
});

describe("readUpdateCheck: a cached failure", () => {
  const HOUR = 60 * 60_000;
  const stale = () => cached({ checkedAt: new Date(NOW - 7 * 3600_000).toISOString() });
  const run = async (github: { calls: unknown[]; fetchImpl: typeof fetch }, initial?: unknown, failure?: unknown, now = NOW) => {
    const db = fakeSql(initial, failure);
    const result = await readUpdateCheck(db.sql, target(), null, { fetchImpl: github.fetchImpl, now });
    return { result, db };
  };
  const down = () => ({ calls: [] as unknown[], fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });

  it("a 5xx is cached for an hour when GitHub gives no reset time", async () => {
    const { db } = await run(upstreamWith(json({}, 502)));
    expect(db.state.failure).toEqual({ until: new Date(NOW + HOUR).toISOString() });
  });

  it("a network error is cached for an hour", async () => {
    const { db } = await run(down());
    expect(db.state.failure).toEqual({ until: new Date(NOW + HOUR).toISOString() });
  });

  it("a rate limit is cached until GitHub's x-ratelimit-reset", async () => {
    const reset = Math.floor((NOW + 17 * 60_000) / 1000);
    const limited = upstreamWith(
      json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    );
    const { db } = await run(limited);
    expect(db.state.failure).toEqual({ until: new Date(reset * 1000).toISOString() });
  });

  it("the reset time of upstream main's read counts too, when that is the call that failed", async () => {
    const reset = Math.floor((NOW + 5 * 60_000) / 1000);
    const limited = fakeGithub({
      "GET repos/drkostas/hevy2garmin/commits/main": json({ message: "API rate limit exceeded" }, 429, { "x-ratelimit-reset": String(reset) }),
    });
    const { db } = await run(limited);
    expect(db.state.failure).toEqual({ until: new Date(reset * 1000).toISOString() });
  });

  it("a retry-after (seconds) is honoured first, over a reset time in the same response", async () => {
    const reset = Math.floor((NOW + 40 * 60_000) / 1000);
    const limited = upstreamWith(
      json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "90", "x-ratelimit-reset": String(reset) }),
    );
    const { db } = await run(limited);
    expect(db.state.failure).toEqual({ until: new Date(NOW + 90_000).toISOString() });
  });

  it("a retry-after on upstream main's read counts too", async () => {
    const limited = fakeGithub({ "GET repos/drkostas/hevy2garmin/commits/main": json({}, 429, { "retry-after": "30" }) });
    const { db } = await run(limited);
    expect(db.state.failure).toEqual({ until: new Date(NOW + 30_000).toISOString() });
  });

  it.each([
    ["not a number", "later"],
    ["zero", "0"],
    ["negative", "-5"],
  ])("a retry-after that is %s falls back to the reset time", async (_name, retryAfter) => {
    const reset = Math.floor((NOW + 12 * 60_000) / 1000);
    const { db } = await run(upstreamWith(json({}, 403, { "retry-after": retryAfter, "x-ratelimit-reset": String(reset) })));
    expect(db.state.failure).toEqual({ until: new Date(reset * 1000).toISOString() });
  });

  it("a bad retry-after and no reset time fall back to an hour", async () => {
    const { db } = await run(upstreamWith(json({}, 503, { "retry-after": "later" })));
    expect(db.state.failure).toEqual({ until: new Date(NOW + HOUR).toISOString() });
  });

  it.each([
    ["in the past", String(Math.floor((NOW - 60_000) / 1000))],
    ["not a number", "soon"],
  ])("a reset time %s falls back to an hour", async (_name, reset) => {
    const { db } = await run(upstreamWith(json({}, 403, { "x-ratelimit-reset": reset })));
    expect(db.state.failure).toEqual({ until: new Date(NOW + HOUR).toISOString() });
  });

  it("while it lasts: no result and no GitHub call, and the stale result stays as it was", async () => {
    const github = upstreamWith(compared("ahead", 5));
    const { result, db } = await run(github, stale(), { until: new Date(NOW + 10 * 60_000).toISOString() });
    expect(result).toBeNull();
    expect(github.calls).toHaveLength(0);
    expect(db.state.value).toEqual(stale());
    expect(db.state.writes + db.state.failureWrites).toBe(0);
  });

  it("a fresh good result is still served while a failure is cached", async () => {
    const github = upstreamWith(compared("ahead", 5));
    const { result } = await run(github, cached(), { until: new Date(NOW + 10 * 60_000).toISOString() });
    expect(result).toEqual(cached());
    expect(github.calls).toHaveLength(0);
  });

  it("once it has passed, GitHub is asked again and a good answer is cached", async () => {
    const github = upstreamWith(compared("ahead", 5));
    const { result, db } = await run(github, stale(), { until: new Date(NOW - 1000).toISOString() });
    expect(github.calls.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: "behind", behindBy: 5 });
    expect(db.state.value).toMatchObject({ behindBy: 5, checkedAt: new Date(NOW).toISOString() });
  });

  it("a failure never touches the cached result, fresh or stale", async () => {
    const { db } = await run(down(), stale());
    expect(db.state.value).toEqual(stale());
    expect(db.state.writes).toBe(0);
  });

  it("a malformed failure entry is ignored", async () => {
    const github = upstreamWith(compared("ahead", 5));
    const { result } = await run(github, undefined, { until: "whenever" });
    expect(result).toMatchObject({ behindBy: 5 });
  });

  it("a cached failure stops the second view from asking GitHub", async () => {
    const github = down();
    let calls = 0;
    const counting = (async (...a: Parameters<typeof fetch>) => { calls++; return github.fetchImpl(...a); }) as typeof fetch;
    const db = fakeSql(stale());
    await readUpdateCheck(db.sql, target(), null, { fetchImpl: counting, now: NOW });
    const first = calls;
    expect(await readUpdateCheck(db.sql, target(), null, { fetchImpl: counting, now: NOW + 30 * 60_000 })).toBeNull();
    expect(calls).toBe(first);
  });
});

describe("readUpdateCheck: the cache", () => {
  const run = async (initial: unknown) => {
    const github = upstreamWith(compared("ahead", 5));
    const db = fakeSql(initial);
    const result = await readUpdateCheck(db.sql, target(), null, { fetchImpl: github.fetchImpl, now: NOW });
    return { result, github, db };
  };

  it("a fresh entry is used as it is, with no GitHub call", async () => {
    const { result, github, db } = await run(cached());
    expect(result).toEqual(cached());
    expect(github.calls).toHaveLength(0);
    expect(db.state.writes).toBe(0);
  });

  it("an entry older than six hours is checked again", async () => {
    const { result, github } = await run(cached({ checkedAt: new Date(NOW - 6 * 3600_000 - 1000).toISOString() }));
    expect(github.calls.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ behindBy: 5, checkedAt: new Date(NOW).toISOString() });
  });

  it("an entry for another deployed commit is checked again (the update landed)", async () => {
    const { github } = await run(cached({ deployedSha: "e".repeat(40) }));
    expect(github.calls.length).toBeGreaterThan(0);
  });

  it("an entry for another upstream is checked again", async () => {
    const { github } = await run(cached({ upstream: "other/h2g" }));
    expect(github.calls.length).toBeGreaterThan(0);
  });

  it("a malformed entry is checked again", async () => {
    const { github } = await run({ checkedAt: "never", status: 7 });
    expect(github.calls.length).toBeGreaterThan(0);
  });

  it("a cache that cannot be read still answers from GitHub", async () => {
    const github = upstreamWith(compared("ahead", 5));
    const sql = ((strings: TemplateStringsArray) =>
      /^\s*SELECT/.test(strings.join("?")) ? Promise.reject(new Error("no table")) : Promise.resolve([])) as never;
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    const result = await readUpdateCheck(sql, target(), null, { fetchImpl: github.fetchImpl, now: NOW });
    expect(result).toMatchObject({ behindBy: 5 });
  });
});

describe("bannerFor", () => {
  it("behind: the count, the compare link and the fork, with Update now only when allowed", () => {
    expect(bannerFor(cached(), target(), true)).toEqual({
      kind: "behind",
      behindBy: 3,
      upstreamSha: UPSTREAM_SHA,
      compareUrl: `https://github.com/drkostas/hevy2garmin/compare/${DEPLOYED}...${UPSTREAM_SHA}`,
      forkUrl: "https://github.com/someone/hevy2garmin",
      docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
      canUpdate: true,
    });
    expect(bannerFor(cached(), target(), false)).toMatchObject({ canUpdate: false });
  });

  it("rewritten: no count and never Update now, the fork and the docs instead", () => {
    const b = bannerFor(cached({ status: "rewritten", behindBy: 0 }), target(), true);
    expect(b).toEqual({
      kind: "rewritten",
      upstreamSha: UPSTREAM_SHA,
      forkUrl: "https://github.com/someone/hevy2garmin",
      docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
      canUpdate: false,
    });
  });

  it("no banner when up to date, while an update is running, or with nothing behind", () => {
    expect(bannerFor(cached({ status: "current", behindBy: 0 }), target(), true)).toBeNull();
    expect(bannerFor(cached({ status: "updating" }), target(), true)).toBeNull();
    expect(bannerFor(cached({ behindBy: 0 }), target(), true)).toBeNull();
    expect(bannerFor(null, target(), true)).toBeNull();
  });
});

describe("markUpdating", () => {
  it("marks the cached entry so the banner stops offering the update", async () => {
    const db = fakeSql(cached());
    await markUpdating(db.sql);
    expect(db.state.value).toEqual(cached({ status: "updating" }));
  });

  it("writes nothing when there is no entry", async () => {
    const db = fakeSql();
    await markUpdating(db.sql);
    expect(db.state.writes).toBe(0);
  });
});

describe("syncFork", () => {
  const fork = "someone/hevy2garmin";
  const repo = json({ default_branch: "trunk" });

  it("calls merge-upstream on the fork's default branch with the token", async () => {
    const github = fakeGithub({
      [`GET repos/${fork}`]: repo,
      [`POST repos/${fork}/merge-upstream`]: json({ message: "Successfully fetched and fast-forwarded", merge_type: "fast-forward" }),
    });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: true, upToDate: false });
    const post = github.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.body!)).toEqual({ branch: "trunk" });
    expect(post.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("merge_type none (GitHub's real answer for a fork in sync) means already up to date", async () => {
    const github = fakeGithub({
      [`GET repos/${fork}`]: repo,
      [`POST repos/${fork}/merge-upstream`]: json({
        message: "This branch is not behind the upstream drkostas:main.",
        merge_type: "none",
        base_branch: "drkostas:main",
      }),
    });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: true, upToDate: true });
  });

  it.each(["fast-forward", "merge"])("merge_type %s means the update started", async (mergeType) => {
    const github = fakeGithub({
      [`GET repos/${fork}`]: repo,
      [`POST repos/${fork}/merge-upstream`]: json({ message: "x", merge_type: mergeType, base_branch: "drkostas:main" }),
    });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: true, upToDate: false });
  });

  it("a 200 without a readable body still means the update started", async () => {
    const github = fakeGithub({
      [`GET repos/${fork}`]: repo,
      [`POST repos/${fork}/merge-upstream`]: () => new Response("not json", { status: 200 }),
    });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: true, upToDate: false });
  });

  it.each([409, 422])("%i means it cannot merge, and it does not retry", async (status) => {
    const github = fakeGithub({ [`GET repos/${fork}`]: repo, [`POST repos/${fork}/merge-upstream`]: json({ message: "x" }, status) });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: false, reason: "cannot-merge" });
    expect(github.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it.each([401, 403])("%i on merge-upstream means the token cannot sync the fork", async (status) => {
    const github = fakeGithub({ [`GET repos/${fork}`]: repo, [`POST repos/${fork}/merge-upstream`]: json({}, status) });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: false, reason: "token" });
  });

  it("401 reading the fork means the token, before any merge is attempted", async () => {
    const github = fakeGithub({ [`GET repos/${fork}`]: json({}, 401) });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: false, reason: "token" });
    expect(github.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("anything else, or the network failing, is a plain failure", async () => {
    const github = fakeGithub({ [`GET repos/${fork}`]: repo, [`POST repos/${fork}/merge-upstream`]: json({}, 500) });
    expect(await syncFork(fork, TOKEN, github.fetchImpl)).toEqual({ ok: false, reason: "failed" });
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(await syncFork(fork, TOKEN, down)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("recheckAfterInSync", () => {
  // merge-upstream said the fork is already in sync. The check compares the
  // deployed commit, which that does not move, so a deployment may still be on
  // its way: the banner must go either way.
  const run = async (github: { calls: unknown[]; fetchImpl: typeof fetch }, initial: unknown = cached()) => {
    const db = fakeSql(initial);
    await recheckAfterInSync(db.sql, target(), TOKEN, { fetchImpl: github.fetchImpl, now: NOW });
    return db;
  };

  it("asks GitHub even when the cached check is fresh, and caches up to date", async () => {
    const github = upstreamWith(compared("identical", 0));
    const db = await run(github);
    expect(github.calls.length).toBeGreaterThan(0);
    expect(db.state.value).toMatchObject({ status: "current", behindBy: 0, checkedAt: new Date(NOW).toISOString() });
    expect(bannerFor(db.state.value as UpdateCheck, target(), true)).toBeNull();
  });

  it("still behind means the deployment is on its way: cached as updating, so no banner", async () => {
    const db = await run(upstreamWith(compared("ahead", 4)));
    expect(db.state.value).toMatchObject({ status: "updating", behindBy: 4, checkedAt: new Date(NOW).toISOString() });
    expect(bannerFor(db.state.value as UpdateCheck, target(), true)).toBeNull();
  });

  it("GitHub failing: the cached entry is marked updating, and no failure replaces it", async () => {
    const down = { calls: [] as unknown[], fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch };
    const db = await run(down);
    expect(db.state.value).toEqual(cached({ status: "updating" }));
    expect(db.state.failureWrites).toBe(0);
  });
});
