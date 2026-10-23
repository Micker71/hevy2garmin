"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import type { UpdateBanner as Banner } from "@/lib/update-check";

/**
 * The dashboard's "update available" banner for a fork (#749).
 *
 * Loads after the page renders, from /api/update-check, so the dashboard
 * never waits on GitHub; any failure there means no banner. Dismissing it
 * hides it until upstream has a newer commit. The dismissed commit is kept in
 * this browser's localStorage: it is a display preference, so it needs no
 * route, no database write and nothing more to protect.
 *
 * **Update now** (Vercel forks with a saved token) posts to /api/update-fork.
 * Once GitHub has taken the update, the banner waits for the new deployment
 * to answer /api/version and reloads the page.
 */
const DISMISSED_KEY = "h2g-update-dismissed";

/** True when the banner was dismissed at this same upstream commit. */
export function isDismissed(banner: Banner, dismissedSha: string | null): boolean {
  return dismissedSha === banner.upstreamSha;
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(sha: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, sha);
  } catch {
    // Without storage the dismissal lasts until the next page load.
  }
}

/** Where Update now is: not asked, asked, taken by GitHub, already in sync, or why it was not. */
export type UpdatePhase = "idle" | "requesting" | "started" | "up-to-date" | "cannot-merge" | "token" | "failed";

/**
 * Wait until the deployed commit differs from the first one read, reading
 * every `intervalMs` up to `timeoutMs`. A failed read (null) is waited past.
 * True when a new version is serving, false at the timeout.
 */
export async function waitForNewVersion(
  readCommit: () => Promise<string | null>,
  { intervalMs, timeoutMs, sleep }: { intervalMs: number; timeoutMs: number; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  let first: string | null = null;
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    if (waited > 0) await sleep(intervalMs);
    const commit = await readCommit();
    if (!commit) continue;
    if (first === null) first = commit;
    else if (commit !== first) return true;
  }
  return false;
}

async function readDeployedCommit(): Promise<string | null> {
  try {
    const r = await fetch(withBasePath("/api/version"), { cache: "no-store" });
    const d = (await r.json()) as { commit?: unknown };
    return typeof d.commit === "string" ? d.commit : null;
  } catch {
    return null;
  }
}

const link = "font-medium text-teal underline";
const button =
  "rounded-lg bg-teal/20 px-3 py-1.5 text-xs font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-60";

export function UpdateBannerView({
  banner,
  phase = "idle",
  onUpdate,
  onDismiss,
}: {
  banner: Banner;
  phase?: UpdatePhase;
  onUpdate?: () => void;
  onDismiss: () => void;
}) {
  const n = banner.behindBy ?? 0;
  const offerUpdate = banner.canUpdate && (phase === "idle" || phase === "requesting" || phase === "failed");
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-teal/40 bg-teal/10 p-4">
      <p className="min-w-0 flex-1 basis-full text-sm text-text sm:basis-60">
        {/* Already in sync, "Update available" and See what's new would contradict the line below. */}
        {phase === "up-to-date" ? null : banner.kind === "behind" ? (
          <>Update available: {n} new {n === 1 ? "change" : "changes"} since your version.</>
        ) : (
          <>
            An update is available. Your fork was made before this project&apos;s history was rewritten, so update it on
            GitHub: <a href={banner.forkUrl} className={link}>open your fork</a> and follow{" "}
            <a href={banner.docsUrl} className={link}>the update steps</a>.
          </>
        )}
        {phase === "started" && (
          <span className="mt-1 block text-text-secondary" role="status">
            Updating… your dashboard will reload with the new version in about a minute.
          </span>
        )}
        {phase === "up-to-date" && (
          <span className="block text-text-secondary" role="status">
            Your fork is already up to date (a new deployment may still be on its way).
          </span>
        )}
        {phase === "cannot-merge" && (
          <span className="mt-1 block text-warm" role="alert">
            GitHub can&apos;t update your fork automatically. <a href={banner.forkUrl} className={link}>Open your fork</a>{" "}
            and follow <a href={banner.docsUrl} className={link}>the update steps</a>.
          </span>
        )}
        {phase === "token" && (
          <span className="mt-1 block text-warm" role="alert">
            The saved GitHub token can&apos;t sync your fork. It needs the <code>repo</code> scope, and{" "}
            <code>workflow</code> when the update changes <code>.github/workflows/</code>. Replace it in{" "}
            <a href={withBasePath("/settings")} className={link}>Settings</a>.
          </span>
        )}
        {phase === "failed" && (
          <span className="mt-1 block text-warm" role="alert">
            The update didn&apos;t start. Try again, or use Sync fork on <a href={banner.forkUrl} className={link}>your fork</a>.
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {offerUpdate && (
          <button type="button" onClick={onUpdate} disabled={phase === "requesting"} className={button}>
            {phase === "requesting" ? "Updating…" : "Update now"}
          </button>
        )}
        {banner.kind === "behind" && banner.compareUrl && phase !== "up-to-date" && (
          <a href={banner.compareUrl} className={`text-xs ${link}`}>
            See what&apos;s new
          </a>
        )}
        <button type="button" onClick={onDismiss} className="text-xs font-medium text-text-muted hover:text-text">
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function UpdateBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");

  useEffect(() => {
    let cancelled = false;
    fetch(withBasePath("/api/update-check"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { banner?: Banner | null } | null) => {
        const b = d?.banner ?? null;
        if (!cancelled && b && !isDismissed(b, readDismissed())) setBanner(b);
      })
      .catch(() => {
        // No banner. The dashboard is complete without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function update() {
    setPhase("requesting");
    try {
      const res = await fetch(withBasePath("/api/update-fork"), { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; upToDate?: boolean; reason?: string };
      if (res.ok && d.ok && d.upToDate) {
        // Nothing was merged, so there is no deployment of ours to wait for.
        setPhase("up-to-date");
        return;
      }
      if (res.ok && d.ok) {
        setPhase("started");
        const arrived = await waitForNewVersion(readDeployedCommit, {
          intervalMs: 15_000,
          timeoutMs: 10 * 60_000,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        if (arrived) window.location.reload();
        return;
      }
      setPhase(d.reason === "cannot-merge" ? "cannot-merge" : d.reason === "token" ? "token" : "failed");
    } catch {
      setPhase("failed");
    }
  }

  if (!banner) return null;
  return (
    <UpdateBannerView
      banner={banner}
      phase={phase}
      onUpdate={update}
      onDismiss={() => {
        writeDismissed(banner.upstreamSha);
        setBanner(null);
      }}
    />
  );
}
