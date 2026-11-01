import { NextResponse } from "next/server";
import { databaseNotAnswering } from "@/lib/db-down";
import { ifNoTable } from "@/lib/missing-table";
import { HEVY_TO_GARMIN } from "hevy2garmin";
import { getDb } from "@/lib/db";
import { categoryName } from "@/lib/garmin-categories";

// Reads the live hevy2garmin Postgres at request time — never at build.
export const dynamic = "force-dynamic";

/**
 * Exercise-mapping summary, mirroring the /mappings page but as JSON so the
 * Expo companion app can render its own Mappings screen.
 *
 * Reads custom_mappings from the hevy2garmin Postgres (same table the web page
 * uses) and counts the package's built-in HEVY_TO_GARMIN map. Shape matches
 * `MappingsResponse` in hevy2garmin/universal/src/lib/api.ts.
 *
 * A read-only GET, kept consistent with /api/hevy/status (no extra auth of its
 * own — the personal-token gate in front of /api/* covers the prod host).
 */

interface CustomMapping {
  hevy_name: string;
  category: number;
  subcategory: number;
}

interface BuiltinSample {
  name: string;
  category: number;
  categoryName: string;
}

interface MappingsResponse {
  dbConfigured: boolean;
  customCount: number;
  builtinCount: number;
  custom: CustomMapping[];
  sample: BuiltinSample[];
}

export async function GET() {
  // The built-in map ships with the package — available regardless of DB state.
  const builtinEntries = Object.entries(HEVY_TO_GARMIN);
  const sample: BuiltinSample[] = builtinEntries.slice(0, 12).map(([name, pair]) => ({
    name,
    category: pair[0],
    categoryName: categoryName(pair[0]),
  }));

  const base: Omit<MappingsResponse, "dbConfigured" | "custom"> = {
    customCount: 0,
    builtinCount: builtinEntries.length,
    sample,
  };

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    // No DATABASE_URL configured — built-in map still works, no custom rows.
    return NextResponse.json({ dbConfigured: false, custom: [], ...base } satisfies MappingsResponse);
  }

  try {
    // `.catch` guards a missing custom_mappings table (fresh deploy that hasn't
    // run the Python schema bootstrap yet).
    const rows = await sql`
      SELECT hevy_name, category, subcategory
      FROM custom_mappings
      ORDER BY hevy_name ASC
    `.catch(ifNoTable([] as Array<{
          hevy_name: string;
          category: number | string;
          subcategory: number | string;
        }>));

    const custom: CustomMapping[] = rows.map((r) => ({
      hevy_name: r.hevy_name,
      category: Number(r.category),
      subcategory: Number(r.subcategory),
    }));

    const body: MappingsResponse = {
      dbConfigured: true,
      customCount: custom.length,
      builtinCount: base.builtinCount,
      custom,
      sample,
    };

    return NextResponse.json(body);
  } catch (error) {
    return databaseNotAnswering("mappings", error);
  }
}
