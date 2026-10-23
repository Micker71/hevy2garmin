import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBannerView, isDismissed, waitForNewVersion, type UpdatePhase } from "./update-banner";
import type { UpdateBanner } from "@/lib/update-check";

/**
 * The dashboard's update banner (#749). What it says for each check and each
 * step of Update now, and when a dismissal hides it.
 */
const SHA = "b".repeat(40);
const behind = (over: Partial<UpdateBanner> = {}): UpdateBanner => ({
  kind: "behind",
  behindBy: 3,
  upstreamSha: SHA,
  compareUrl: "https://github.com/drkostas/hevy2garmin/compare/a...b",
  forkUrl: "https://github.com/someone/hevy2garmin",
  docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
  canUpdate: true,
  ...over,
});
const rewritten = (): UpdateBanner => ({
  kind: "rewritten",
  upstreamSha: SHA,
  forkUrl: "https://github.com/someone/hevy2garmin",
  docsUrl: "https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy",
  canUpdate: false,
});
const render = (banner: UpdateBanner, phase: UpdatePhase = "idle") =>
  renderToStaticMarkup(<UpdateBannerView banner={banner} phase={phase} onUpdate={() => {}} onDismiss={() => {}} />);

describe("UpdateBannerView", () => {
  it("behind: the count, See what's new, Update now and Dismiss", () => {
    const html = render(behind());
    expect(html).toContain("Update available: 3 new changes since your version");
    expect(html).toContain('href="https://github.com/drkostas/hevy2garmin/compare/a...b"');
    expect(html).toContain("See what&#x27;s new");
    expect(html).toContain("Update now");
    expect(html).toContain("Dismiss");
  });

  it("says change, not changes, for one", () => {
    expect(render(behind({ behindBy: 1 }))).toContain("1 new change since your version");
  });

  it("no Update now when it is not allowed (self-hosted, or no token)", () => {
    const html = render(behind({ canUpdate: false }));
    expect(html).not.toContain("Update now");
    expect(html).toContain("See what&#x27;s new");
  });

  it("a pre-rewrite fork: no count, no Update now, the fork and the docs", () => {
    const html = render(rewritten());
    expect(html).toContain("An update is available");
    expect(html).not.toMatch(/\d+ new change/);
    expect(html).not.toContain("Update now");
    expect(html).toContain('href="https://github.com/someone/hevy2garmin"');
    expect(html).toContain('href="https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy"');
  });

  it("while the request runs, the button says so and is disabled", () => {
    const html = render(behind(), "requesting");
    expect(html).toContain("Updating…");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("once started: the reload message and no button", () => {
    const html = render(behind(), "started");
    expect(html).toContain("Updating… your dashboard will reload with the new version in about a minute");
    expect(html).not.toContain("Update now");
  });

  it("already in sync: says so, with no polling message and no button", () => {
    const html = render(behind(), "up-to-date");
    expect(html).toContain("Your fork is already up to date (a new deployment may still be on its way).");
    expect(html).not.toContain("Update available");
    expect(html).not.toMatch(/\d+ new change/);
    expect(html).not.toContain("See what&#x27;s new");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Updating…");
    expect(html).not.toContain("Update now");
  });

  it("409/422: the fork and the docs, no retry", () => {
    const html = render(behind(), "cannot-merge");
    expect(html).toContain("GitHub can&#x27;t update your fork automatically");
    expect(html).toContain('href="https://github.com/someone/hevy2garmin"');
    expect(html).toContain('href="https://github.com/drkostas/hevy2garmin#vercel-fork-based-deploy"');
    expect(html).not.toContain("Update now");
  });

  it("401/403: the token needs repo, and workflow when workflows changed", () => {
    const html = render(behind(), "token");
    expect(html).toContain("saved GitHub token can&#x27;t sync your fork");
    expect(html).toContain("<code>repo</code>");
    expect(html).toContain("<code>workflow</code>");
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain("Update now");
  });

  it("any other failure: says so, and Update now can be tried again", () => {
    const html = render(behind(), "failed");
    expect(html).toContain("The update didn&#x27;t start");
    expect(html).toContain("Update now");
  });
});

describe("isDismissed", () => {
  it("hides the banner for the upstream commit it was dismissed at", () => {
    expect(isDismissed(behind(), SHA)).toBe(true);
  });

  it("brings it back when upstream has a newer commit", () => {
    expect(isDismissed(behind({ upstreamSha: "c".repeat(40) }), SHA)).toBe(false);
  });

  it("shows it when nothing was dismissed", () => {
    expect(isDismissed(behind(), null)).toBe(false);
  });
});

describe("waitForNewVersion", () => {
  const sleep = vi.fn(async () => {});

  it("resolves true once the deployed commit differs from the first one it read", async () => {
    const commits = ["old", "old", "old", "new"];
    const read = vi.fn(async () => commits.shift() ?? null);
    expect(await waitForNewVersion(read, { intervalMs: 15_000, timeoutMs: 600_000, sleep })).toBe(true);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("keeps waiting through failed reads", async () => {
    const commits: Array<string | null> = ["old", null, null, "new"];
    const read = vi.fn(async () => commits.shift() ?? null);
    expect(await waitForNewVersion(read, { intervalMs: 15_000, timeoutMs: 600_000, sleep })).toBe(true);
  });

  it("gives up at the timeout", async () => {
    const read = vi.fn(async () => "old");
    expect(await waitForNewVersion(read, { intervalMs: 15_000, timeoutMs: 60_000, sleep })).toBe(false);
    expect(read).toHaveBeenCalledTimes(5);
  });
});
