import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getGithubPat } from "@/lib/github";
import { bannerFor, canUpdateFork, readUpdateCheck, updateTarget } from "@/lib/update-check";

// Reads GitHub and app_cache at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/update-check
 *
 * The dashboard's update banner (#749): `{ banner }`, null when there is
 * nothing to show. The dashboard loads this after it renders, so it never
 * waits on GitHub, and any failure here is no banner rather than an error.
 * When there is nothing to check (turned off, the demo, no deployed commit,
 * no fork, or the upstream repo itself) it reads nothing and asks GitHub
 * nothing. Otherwise it answers from `app_cache`, asking GitHub at most every
 * six hours. The saved token authenticates the call and never leaves here.
 */
export async function GET() {
  const target = updateTarget();
  if (!target) return NextResponse.json({ banner: null });
  try {
    const sql = getDb();
    const pat = await getGithubPat(sql);
    const check = await readUpdateCheck(sql, target, pat);
    return NextResponse.json({ banner: bannerFor(check, target, canUpdateFork(pat)) });
  } catch {
    return NextResponse.json({ banner: null });
  }
}
