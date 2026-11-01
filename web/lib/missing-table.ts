/** Postgres's code for "relation does not exist". */
const UNDEFINED_TABLE = "42P01";

/** True when a database error says the table a query read does not exist yet. */
export function isMissingTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

/**
 * For a read's `.catch()`: answer `fallback` when the table does not exist yet, and throw any
 * other failure.
 *
 * These reads used to end in `.catch(() => [])`, which was meant for a fresh install, and it also
 * caught a refused connection or a provider's quota. The pages then showed an empty account
 * ("Connect Hevy and Garmin to start syncing", zero workouts), which reads as lost data. A
 * database that does not answer is not an empty one (#765).
 */
export function ifNoTable<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (isMissingTable(error)) return fallback;
    throw error;
  };
}
