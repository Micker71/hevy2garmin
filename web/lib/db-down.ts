import { NextResponse } from "next/server";

/**
 * What a read API answers when the database does not answer: a 503 that says so. It used to be
 * a 200 with empty data, which a client shows as an empty account (#765).
 */
export function databaseNotAnswering(route: string, error: unknown): NextResponse {
  console.error(`[${route}] the database did not answer:`, (error as Error)?.message ?? error);
  return NextResponse.json(
    { error: "The database is not answering. Try again later." },
    { status: 503 },
  );
}
