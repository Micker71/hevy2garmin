import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { authEnabled, verifySession, SESSION_COOKIE } from "@/lib/auth";
import { getGithubPat } from "@/lib/github";
import { docsUrl, forkUrl, markUpdating, recheckAfterInSync, syncFork, updateTarget } from "@/lib/update-check";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/update-fork
 *
 * The dashboard's **Update now** (#749): what GitHub's Sync fork button does,
 * through merge-upstream on the fork's default branch with the saved token.
 * Vercel redeploys when the fork's branch moves. Only on a Vercel fork with a
 * saved token; self-hosted there is nothing to redeploy from the fork.
 *
 * When GitHub had nothing to merge (merge_type "none") the answer says the
 * fork is already up to date, and the cached check is refreshed so the banner
 * goes; otherwise the cached check is marked as updating.
 *
 * A 409 or 422 from GitHub is not retried: the answer carries the fork and the
 * README's update steps instead. A 401 or 403 means the token cannot sync the
 * fork. The token is never in any answer.
 */
export async function POST() {
  if (authEnabled()) {
    const store = await cookies();
    if (!(await verifySession(store.get(SESSION_COOKIE)?.value ?? null))) {
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }
  }
  // The proxy refuses this in the demo already; this keeps the route safe on its own.
  if (demoMode()) return NextResponse.json({ ok: false, message: "Read-only in demo mode" }, { status: 403 });

  const target = updateTarget();
  if (!target) {
    return NextResponse.json({ ok: false, reason: "nothing-to-update", message: "There is no fork update to check here." }, { status: 400 });
  }
  if (!process.env.VERCEL) {
    return NextResponse.json(
      { ok: false, reason: "self-hosted", message: "Update now works on a Vercel deployment of a fork. Update this server the way you installed it." },
      { status: 400 },
    );
  }

  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();
  } catch {
    sql = null;
  }
  const pat = await getGithubPat(sql);
  if (!pat) {
    return NextResponse.json(
      { ok: false, reason: "no-token", message: "Save a GitHub token in Settings to update from here." },
      { status: 400 },
    );
  }

  const result = await syncFork(target.fork, pat);
  if (result.ok) {
    if (sql) await (result.upToDate ? recheckAfterInSync(sql, target, pat) : markUpdating(sql));
    return NextResponse.json({ ok: true, upToDate: result.upToDate });
  }
  if (result.reason === "cannot-merge") {
    return NextResponse.json(
      { ok: false, reason: "cannot-merge", forkUrl: forkUrl(target.fork), docsUrl: docsUrl(target.upstream) },
      { status: 409 },
    );
  }
  if (result.reason === "token") {
    return NextResponse.json(
      {
        ok: false,
        reason: "token",
        message:
          "The saved GitHub token can't sync your fork. It needs the repo scope, and the workflow scope when the update changes .github/workflows/.",
      },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: false, reason: "failed", message: "GitHub didn't start the update." }, { status: 502 });
}
