import { NextResponse } from "next/server";
import { databaseNotAnswering } from "@/lib/db-down";
import { ifNoTable } from "@/lib/missing-table";
import { getDb } from "@/lib/db";

// Reads the live hevy2garmin Postgres at request time — never at build.
export const dynamic = "force-dynamic";

/**
 * Synced + in-flight workouts as JSON, mirroring the /workouts page query so the
 * Expo companion app can render its own Workouts screen.
 *
 * Reads synced_workouts (terminal) and pending_uploads (in-flight) from the
 * hevy2garmin Postgres — the same two tables the web /workouts page reads. Shape
 * matches `WorkoutsResponse` in hevy2garmin/universal/src/lib/api.ts.
 *
 * A read-only GET, kept consistent with /api/hevy/status (the personal-token
 * gate in front of /api/* covers the prod host).
 */

interface WorkoutItem {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  // When a resync last rewrote the row; synced_at stays the original sync.
  // Optional for a client built before it existed (#709).
  resynced_at?: string | null;
  calories: number | null;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  // Terminal status (success/manual/skipped) or a pending phase.
  status: string;
  kind: "terminal" | "pending";
  detail: string | null;
}

interface WorkoutsResponse {
  dbConfigured: boolean;
  workouts: WorkoutItem[];
}

const EMPTY: WorkoutsResponse = { dbConfigured: false, workouts: [] };

export async function GET() {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    // No DATABASE_URL configured — return sane defaults rather than a 500.
    return NextResponse.json(EMPTY);
  }

  try {
    const [terminal, pending] = await Promise.all([
      sql`
        SELECT hevy_id, title, synced_at, resynced_at, calories, avg_hr, garmin_activity_id,
               COALESCE(status, 'success') AS status
        FROM synced_workouts
        ORDER BY synced_at DESC
        LIMIT 50
      `.catch(ifNoTable([] as Array<{
            hevy_id: string;
            title: string | null;
            synced_at: string | null;
            resynced_at: string | null;
            calories: number | null;
            avg_hr: number | null;
            garmin_activity_id: string | null;
            status: string;
          }>)),
      sql`
        SELECT hevy_id, phase, next_step, last_error, garmin_activity_id,
               created_at,
               (payload ->> 'title') AS payload_title
        FROM pending_uploads
        ORDER BY created_at DESC
        LIMIT 50
      `.catch(ifNoTable([] as Array<{
            hevy_id: string;
            phase: string | null;
            next_step: string | null;
            last_error: string | null;
            garmin_activity_id: string | null;
            created_at: string | null;
            payload_title: string | null;
          }>)),
    ]);

    const pendingItems: WorkoutItem[] = pending.map((p) => ({
      hevy_id: p.hevy_id,
      title: p.payload_title ?? "",
      synced_at: p.created_at ?? null,
      resynced_at: null,
      calories: null,
      avg_hr: null,
      garmin_activity_id: p.garmin_activity_id ?? null,
      status: p.phase ?? "pending",
      kind: "pending",
      detail: p.last_error ?? p.next_step ?? null,
    }));

    const pendingIds = new Set(pendingItems.map((p) => p.hevy_id));

    const terminalItems: WorkoutItem[] = terminal
      // A hevy_id in pending_uploads is mid-flight; prefer its pending row.
      .filter((t) => !pendingIds.has(t.hevy_id))
      .map((t) => ({
        hevy_id: t.hevy_id,
        title: t.title ?? "",
        synced_at: t.synced_at ?? null,
        resynced_at: t.resynced_at ?? null,
        calories: t.calories != null ? Number(t.calories) : null,
        avg_hr: t.avg_hr != null ? Number(t.avg_hr) : null,
        garmin_activity_id: t.garmin_activity_id ?? null,
        status: t.status,
        kind: "terminal",
        detail: null,
      }));

    // Pending first (they need attention), then terminal, each newest-first.
    const workouts = [...pendingItems, ...terminalItems].slice(0, 50);

    return NextResponse.json({ dbConfigured: true, workouts } satisfies WorkoutsResponse);
  } catch (error) {
    return databaseNotAnswering("workouts", error);
  }
}
