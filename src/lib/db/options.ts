
/**
 * Connection options that work locally and on Supabase/Vercel.
 * - Supabase's transaction pooler (port 6543) doesn't support prepared statements → prepare: false.
 * - Disables extended-protocol pipelining (max_pipeline: 1) so postgres.js v4 never concatenates a new
 *   Parse+Describe+Flush onto Bind+Execute+Sync across a Supavisor transaction boundary (which deadlocks).
 * - Disables runtime pg_type catalog reflection (fetch_types: false): citext parses natively as text, and
 *   skipping pg_type avoids extra connections and mid-stream frame pauses on users.email.
 * - Any non-local host gets TLS (Supabase requires it). Override with DB_SSL=disable|require.
 * - Serverless functions keep pools small; many instances share the pooler. Override with DB_POOL_MAX.
 */
export function connectionOptions(
  databaseUrl: string,
  defaults: { max?: number } = {},
): {
  max: number;
  ssl: false | "require";
  prepare: boolean;
  max_pipeline: number;
  fetch_types: boolean;
  onnotice: () => void;
} {
  const url = new URL(databaseUrl);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const transactionPooler = url.port === "6543" || url.searchParams.get("pgbouncer") === "true";
  const sslEnv = process.env.DB_SSL;
  const ssl: false | "require" = sslEnv === "disable" ? false : sslEnv === "require" || !local ? "require" : false;
  const max = Number(process.env.DB_POOL_MAX) || defaults.max || (process.env.VERCEL ? 3 : 10);
  return {
    max,
    ssl,
    prepare: !transactionPooler,
    max_pipeline: 1,
    fetch_types: false,
    onnotice: () => {},
  };
}
