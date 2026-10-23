// Spike R6: run PGlite + pgvector + Hono from a `bun build --compile` single binary.
// Assets are embedded with `type: "file"` and handed to PGlite explicitly.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
// @ts-expect-error bun file import
import initdbPath from "../../node_modules/@electric-sql/pglite/dist/initdb.wasm" with {
  type: "file",
};
// @ts-expect-error bun file import
import dataPath from "../../node_modules/@electric-sql/pglite/dist/pglite.data" with {
  type: "file",
};
// @ts-expect-error bun file import
import wasmPath from "../../node_modules/@electric-sql/pglite/dist/pglite.wasm" with {
  type: "file",
};
// @ts-expect-error bun file import
import vectorPath from "../../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz" with {
  type: "file",
};

const dataDir = process.argv[2] as string;
// PGlite cannot open extension tarballs inside $bunfs; copy them next to the data dir once.
const extDir = `${dataDir}-ext`;
mkdirSync(extDir, { recursive: true });
const vectorFile = join(extDir, "vector.tar.gz");
writeFileSync(vectorFile, readFileSync(vectorPath));
const t0 = performance.now();
const db = await PGlite.create({
  dataDir,
  pgliteWasmModule: await WebAssembly.compile(readFileSync(wasmPath)),
  initdbWasmModule: await WebAssembly.compile(readFileSync(initdbPath)),
  fsBundle: new Blob([readFileSync(dataPath)]),
  extensions: {
    vector: {
      name: "vector",
      setup: async (_pg: unknown, emscriptenOpts: unknown) => ({
        emscriptenOpts,
        bundlePath: new URL(`file://${vectorFile}`),
      }),
    },
  },
});
await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
await db.exec("CREATE TABLE IF NOT EXISTS t (id int, e vector(2))");
await db.exec("INSERT INTO t VALUES (1, '[1,0]')");
const r = await db.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM t WHERE e <=> '[1,0]' < 0.1",
);
const app = new Hono().get("/", (c) => c.json({ ok: true }));
const res = await app.request("/");
console.log(
  JSON.stringify({
    rows: r.rows[0]?.n,
    hono: (await res.json()).ok,
    ms: Math.round(performance.now() - t0),
  }),
);
await db.close();
