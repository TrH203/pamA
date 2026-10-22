// Contract test: the Zod digest schema agrees with contracts/session-digest.schema.json (Ajv).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { SessionDigestSchema } from "../../src/schema/digest.ts";

const typesDir = join(import.meta.dirname, "../../../../packages/types");
const schema = JSON.parse(
  readFileSync(join(typesDir, "schema/session-digest.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const fixtures = readdirSync(join(typesDir, "fixtures"))
  .filter((f) => f.startsWith("digest-"))
  .sort()
  .map((f) => ({ name: f, doc: JSON.parse(readFileSync(join(typesDir, "fixtures", f), "utf8")) }));

describe("SessionDigest contract", () => {
  it("has fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(2);
  });

  for (const { name, doc } of fixtures) {
    const expected = name.startsWith("digest-valid-");
    it(`${name}: Ajv and Zod both ${expected ? "accept" : "reject"}`, () => {
      expect(validate(doc)).toBe(expected);
      expect(SessionDigestSchema.safeParse(doc).success).toBe(expected);
    });
  }
});
