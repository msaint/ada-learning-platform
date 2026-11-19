import postgres from "postgres";
import { env } from "@/lib/env";
import { connectionOptions } from "./options";
import { createMemoryDb } from "./memory";

type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

const globalForDb = globalThis as unknown as {
  __adaSql?: Sql;
  __adaRawPg?: Sql;
  __adaFallbackDb?: Sql;
};

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? "";
  const msg = e?.message ?? "";
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "CONNECT_TIMEOUT" ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CONNECT_TIMEOUT/i.test(msg)
  );
}

function getFallback(): Sql {
  if (!globalForDb.__adaFallbackDb) {
    globalForDb.__adaFallbackDb = createMemoryDb();
  }
  return globalForDb.__adaFallbackDb;
}

function createResilientClient(url: string): Sql {
  let rawPg: Sql | null = null;
  let useMemory = false;

  try {
    rawPg = postgres(url, {
      ...connectionOptions(url),
      connect_timeout: 3,
      idle_timeout: 20,
      transform: { undefined: null },
    }) as Sql;
    globalForDb.__adaRawPg = rawPg;
  } catch {
    useMemory = true;
  }

  const switchToMemory = (): Sql => {
    if (!useMemory) {
      useMemory = true;
      if (rawPg) {
        void rawPg.end({ timeout: 1 }).catch(() => {});
        rawPg = null;
        globalForDb.__adaRawPg = undefined;
      }
    }
    return getFallback();
  };

  const wrapper = ((first: TemplateStringsArray | string | unknown[], ...rest: unknown[]) => {
    if (useMemory || !rawPg) {
      return (getFallback() as unknown as (...args: unknown[]) => unknown)(first, ...rest);
    }
    // Helper call like sql(table) or sql(ids)
    if (!Array.isArray(first) || !("raw" in first)) {
      return (rawPg as unknown as (...args: unknown[]) => unknown)(first, ...rest);
    }
    const activePg = rawPg;
    return Promise.resolve(activePg(first as TemplateStringsArray, ...(rest as never[]))).catch((err: unknown) => {
      if (isConnectionError(err)) {
        const mem = switchToMemory();
        return mem(first as TemplateStringsArray, ...(rest as never[]));
      }
      throw err;
    });
  }) as unknown as Sql;

  Object.assign(wrapper, {
    begin: async <T>(fn: (t: Tx) => Promise<T>): Promise<T> => {
      if (useMemory || !rawPg) {
        return getFallback().begin(fn) as Promise<T>;
      }
      try {
        return (await rawPg.begin(fn)) as T;
      } catch (err) {
        if (isConnectionError(err)) {
          return switchToMemory().begin(fn) as Promise<T>;
        }
        throw err;
      }
    },
    json: (value: unknown) => {
      if (useMemory || !rawPg) {
        return getFallback().json(value as postgres.JSONValue);
      }
      return rawPg.json(value as postgres.JSONValue);
    },
    end: async (opts?: { timeout?: number }) => {
      if (rawPg) {
        await rawPg.end(opts).catch(() => {});
        rawPg = null;
      }
    },
  });

  return wrapper;
}

/** Shared connection pool (survives Next.js dev hot reloads). Falls back to in-memory mock when PostgreSQL is unavailable. */
export function db(): Sql {
  if (!globalForDb.__adaSql) {
    const url = env().DATABASE_URL;
    globalForDb.__adaSql = url ? createResilientClient(url) : getFallback();
  }
  return globalForDb.__adaSql;
}

export async function closeDb() {
  if (globalForDb.__adaSql) {
    await globalForDb.__adaSql.end({ timeout: 5 });
    globalForDb.__adaSql = undefined;
    globalForDb.__adaRawPg = undefined;
  }
}

export function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  return db().begin(fn) as Promise<T>;
}

/** postgres.js returns jsonb as parsed values; this helper encodes values for jsonb params. */
export function json(value: unknown) {
  return db().json(value as postgres.JSONValue);
}
