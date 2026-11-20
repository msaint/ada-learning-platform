import { afterEach, describe, expect, it } from "vitest";
import { FallbackLearningModel } from "@/lib/ai/fallback-model";
import { MockLearningModel } from "@/lib/ai/mock-model";
import { buildModel } from "@/lib/ai";
import { resetEnvCache } from "@/lib/env";
import { connectionOptions } from "@/lib/db/options";
import { AppError, ModelError } from "@/lib/errors";
import type { LearningModel } from "@/lib/ai/model-adapter";

process.env.ADA_SILENT_LOGS = "true";
const ctx = { topic: "Knots", answers: [], askedFields: [], questionsAsked: 0, maxQuestions: 4, startNow: true, linkContext: null };

function failing(err: Error): LearningModel {
  const m = new MockLearningModel();
  return new Proxy(m, { get: (t, k) => (k === "provider" ? "broken" : typeof (t as never)[k] === "function" ? async () => { throw err; } : (t as never)[k]) });
}

describe("cross-provider fallback", () => {
  it("uses the secondary provider when the primary times out", async () => {
    const m = new FallbackLearningModel(failing(new ModelError("model_timeout", "slow")), new MockLearningModel());
    const r = await m.clarifyCourse(ctx);
    expect(r.info.provider).toBe("mock");
  });
  it("does not mask non-model errors", async () => {
    const m = new FallbackLearningModel(failing(new AppError("rate_limited", "x")), new MockLearningModel());
    await expect(m.clarifyCourse(ctx)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("provider selection", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });
  const configure = (env: Record<string, string | undefined>) => {
    process.env = { ...saved, MOCK_MODEL: "false", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ADA_MODEL_PROVIDER: "", ...env };
    resetEnvCache();
    return buildModel().provider;
  };
  it("picks the only configured provider", () => {
    expect(configure({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("anthropic");
    expect(configure({ OPENAI_API_KEY: "sk-test" })).toBe("openai");
  });
  it("chains both with the preferred one first, unless fallback is off", () => {
    expect(configure({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("openai+anthropic");
    expect(configure({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test", ADA_MODEL_PROVIDER: "anthropic" })).toBe("anthropic+openai");
    expect(configure({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test", ADA_MODEL_FALLBACK: "false" })).toBe("openai");
  });
  it("falls back to the dev model with no keys outside production", () => {
    expect(configure({})).toBe("mock");
  });
});

describe("database connection options", () => {
  it("disables prepared statements, pipelining, and pg_type reflection for the Supabase transaction pooler", () => {
    const o = connectionOptions("postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
    expect(o).toMatchObject({ prepare: false, ssl: "require", max_pipeline: 1, fetch_types: false });
  });
  it("keeps prepared statements and plain TCP locally while disabling pipelining and pg_type reflection", () => {
    expect(connectionOptions("postgres://postgres:postgres@localhost:5432/ada_dev")).toMatchObject({
      prepare: true,
      ssl: false,
      max_pipeline: 1,
      fetch_types: false,
    });
  });
  it("serializes concurrent queries on a transaction pooler without cross-Sync pipelining or extra pg_type sockets", async () => {
    const net = await import("node:net");
    const { default: postgres } = await import("postgres");

    const pgFrame = (type: string, payload: Buffer = Buffer.alloc(0)) => {
      const buf = Buffer.alloc(5 + payload.length);
      buf[0] = type.charCodeAt(0);
      buf.writeInt32BE(4 + payload.length, 1);
      payload.copy(buf, 5);
      return buf;
    };

    const framesPerConn: string[][] = [];
    const server = net.createServer((sock) => {
      const connIdx = framesPerConn.length;
      framesPerConn.push([]);
      let startup = true;
      let buf: Buffer = Buffer.alloc(0);
      sock.on("data", (chunk: Buffer | string) => {
        buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        if (startup) {
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          startup = false;
          const authOk = Buffer.alloc(4);
          sock.write(Buffer.concat([pgFrame("R", authOk), pgFrame("Z", Buffer.from("I"))]));
        }
        const batch: string[] = [];
        let sawSyncInChunk = false;
        while (buf.length >= 5) {
          const type = String.fromCharCode(buf[0]);
          const len = buf.readInt32BE(1);
          if (buf.length < 1 + len) break;
          buf = buf.subarray(1 + len);
          batch.push(type);
          // Supavisor transaction mode: if P+D+H is concatenated behind B+E+S in the same packet,
          // the backend is released at S and trailing H is never answered without another S.
          if (type === "H" && !sawSyncInChunk) {
            const pd = Buffer.alloc(6);
            pd.writeInt16BE(1, 0);
            pd.writeInt32BE(2950, 2);
            const colName = Buffer.from("email\0");
            const rdRest = Buffer.alloc(18);
            rdRest.writeInt32BE(16400, 6); // citext OID >= 16384
            rdRest.writeInt16BE(-1, 10);
            rdRest.writeInt32BE(-1, 12);
            const rdHdr = Buffer.alloc(2);
            rdHdr.writeInt16BE(1, 0);
            sock.write(Buffer.concat([pgFrame("1"), pgFrame("t", pd), pgFrame("T", Buffer.concat([rdHdr, colName, rdRest]))]));
          } else if (type === "S") {
            sawSyncInChunk = true;
            sock.write(Buffer.concat([pgFrame("2"), pgFrame("C", Buffer.from("SELECT 0\0")), pgFrame("Z", Buffer.from("I"))]));
          }
        }
        if (batch.length) framesPerConn[connIdx].push(batch.join("+"));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const url = `postgresql://u:pw@127.0.0.1:${addr.port}/postgres?pgbouncer=true`;
    const sql = postgres(url, { ...connectionOptions(url, { max: 3 }), ssl: false });
    try {
      const id = "00000000-0000-0000-0000-000000000000";
      await Promise.all([
        sql`select email from users where id = ${id}`,
        sql`select email from users where id = ${id}`,
        sql`select email from users where id = ${id}`,
        sql`select email from users where id = ${id}`,
      ]);
      expect(framesPerConn.length).toBeLessThanOrEqual(3);
      for (const batches of framesPerConn) {
        expect(batches).not.toContain("B+E+S+P+D+H");
      }
    } finally {
      await sql.end();
      server.close();
    }
  });
});
