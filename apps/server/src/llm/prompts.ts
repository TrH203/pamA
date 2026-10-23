// Versioned prompts from the repository's prompts/ directory. Each file starts with front matter:
//   ---
//   version: 3
//   ---
// The version (e.g. "digest@3") is stored with every digest/answer as provenance.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROMPTS_DIR =
  process.env.PAMA_PROMPTS_DIR ?? join(import.meta.dirname, "../../../../prompts");

export interface Prompt {
  name: string;
  /** "<name>@<version>" */
  version: string;
  body: string;
}

const cache = new Map<string, Prompt>();

export function parsePrompt(name: string, raw: string): Prompt {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`prompt ${name}: missing front matter`);
  const version = /^version:\s*(\S+)\s*$/m.exec(m[1] as string)?.[1];
  if (!version) throw new Error(`prompt ${name}: missing version`);
  return { name, version: `${name}@${version}`, body: (m[2] as string).trim() };
}

export function loadPrompt(name: string, dir = PROMPTS_DIR): Prompt {
  const key = `${dir}/${name}`;
  let p = cache.get(key);
  if (!p) {
    p = parsePrompt(name, readFileSync(join(dir, `${name}.md`), "utf8"));
    cache.set(key, p);
  }
  return p;
}

/** Replace {{var}} placeholders. Unknown variables are an error, not silently empty. */
export function render(p: Prompt, vars: Record<string, string>): string {
  return p.body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`prompt ${p.name}: missing variable ${k}`);
    return v;
  });
}
