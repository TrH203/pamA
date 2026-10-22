// Entry point of the compiled desktop sidecar (`bun build --compile`, research R6). Embeds the
// PGlite runtime files, hands them to the Db adapter, then starts the normal server.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error Bun file import
import initdbPath from "../node_modules/@electric-sql/pglite/dist/initdb.wasm" with {
  type: "file",
};
// @ts-expect-error Bun file import
import dataPath from "../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
// @ts-expect-error Bun file import
import wasmPath from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
// @ts-expect-error Bun file import
import vectorPath from "../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz" with {
  type: "file",
};
import { usePgliteAssets } from "./db/client.ts";

const dataDir = process.env.PAMA_DATA_DIR ?? join(homedir(), ".pama", "server");
const extDir = join(dataDir, "extensions");
mkdirSync(extDir, { recursive: true });
const vectorFile = join(extDir, "vector.tar.gz");
writeFileSync(vectorFile, readFileSync(vectorPath));

usePgliteAssets({
  pgliteWasmModule: await WebAssembly.compile(readFileSync(wasmPath)),
  initdbWasmModule: await WebAssembly.compile(readFileSync(initdbPath)),
  fsBundle: new Blob([readFileSync(dataPath)]),
  vectorBundle: pathToFileURL(vectorFile),
});

await import("./index.ts");
