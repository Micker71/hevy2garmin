import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authEnabled, verifySession, SESSION_COOKIE } from "@/lib/auth";
import { demoMode } from "@/lib/demo";
import { resolveDatabaseUrl, DATABASE_URL_VARS } from "@/lib/database-url";

// Temporary, read-only diagnostic to validate the isolated Vercel Preview.
// Does not connect to Postgres or invoke Hevy, Garmin, GitHub or an upload.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return new NextResponse(null, { status: 404 });
  }

  // Fail closed when preview is not in read-only mode.
  if (!demoMode()) {
    return NextResponse.json(
      { result: "FAIL", preview: true, demoMode: false },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Do not disclose even the non-secret endpoint identifier without app login.
  if (!authEnabled()) {
    return new NextResponse(null, { status: 401 });
  }
  const session = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!(await verifySession(session))) {
    return new NextResponse(null, { status: 401 });
  }

  const url = resolveDatabaseUrl();
  const variable = url
    ? DATABASE_URL_VARS.find((key) => process.env[key]?.trim() === url) ?? null
    : null;
  let endpointId: string | null = null;

  if (url) {
    try {
      const hostLabel = new URL(url).hostname.split(".")[0];
      const normalized = hostLabel.replace(/-pooler$/, "");
      if (/^ep-[a-z0-9-]+$/.test(normalized)) endpointId = normalized;
    } catch {
      // Never include the URL or credentials in a diagnostic response.
    }
  }

  return NextResponse.json(
    {
      result: demoMode() && endpointId ? "CHECK_ENDPOINT" : "UNVERIFIED",
      environment: "preview",
      demoMode: true,
      databaseVariable: variable,
      neonEndpointId: endpointId,
      note: "Compare neonEndpointId against Neon Preview branch Computes. No database query performed.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
