import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { assertSchemaProfile } from "./schema-profile.mjs";

const root = new URL("../", import.meta.url);
const schemaDirectory = new URL("packages/contracts/schema/", root);
const outputDirectory = new URL("packages/contracts/src/generated/", root);
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== "--check") || arguments_.length > 1) {
  throw new Error("Usage: node scripts/generate-types.mjs [--check]");
}
const check = arguments_.includes("--check");
const names = (await readdir(schemaDirectory)).filter((name) => name.endsWith(".schema.json")).sort();
if (names.length !== 4) throw new Error("Contract profile 0.1 requires its four explicitly reviewed schema files");
const expectedNames = ["command-receipt.schema.json", "command.schema.json", "execution-evidence.schema.json", "setup-request.schema.json"];
if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error("Unreviewed contract schema file set");
if (!check) await mkdir(outputDirectory, { recursive: true });
let changed = 0;
const schemaDigests = {};
async function emit(name, generated) {
  const output = new URL(name, outputDirectory);
  if (check) {
    const existing = await readFile(output, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== generated) { console.error(`Generated declaration differs: ${name}`); changed += 1; }
  } else {
    await writeFile(output, generated, "utf8");
  }
}
for (const name of names) {
  const sourceBytes = await readFile(new URL(name, schemaDirectory));
  const schema = assertSchemaProfile(JSON.parse(sourceBytes.toString("utf8")));
  schemaDigests[name.replace(".schema.json", "")] = createHash("sha256").update(sourceBytes).digest("hex");
  const generated = await compile(schema, schema.title, {
    cwd: fileURLToPath(schemaDirectory),
    $refOptions: { resolve: { external: false, file: false, http: false }, dereference: { circular: false } },
    additionalProperties: false,
    unknownAny: true,
    strictIndexSignatures: true,
    maxItems: 32,
    bannerComment: `/* Generated from packages/contracts/schema/${name}. DO NOT EDIT.\n * Shape declarations only; authorization and runtime refinement remain separate. */`,
    style: { singleQuote: false, semi: true, tabWidth: 2 },
  });
  if (/\bany\b|\[k: string\]/.test(generated)) throw new Error(`${name}: generator emitted an open or any boundary`);
  await emit(name.replace(".schema.json", ".ts"), generated);
}
await emit("schema-digests.ts", "/* Generated from the exact bytes of the four bundled schemas. DO NOT EDIT.\n"
  + " * Binds runtime schemas to generated declarations; not an authenticity or authorization proof. */\n"
  + "export const SCHEMA_DIGESTS = " + JSON.stringify(schemaDigests, null, 2) + " as const;\n");
if (changed !== 0) process.exitCode = 1;
else console.log(`${check ? "Checked" : "Generated"} ${names.length + 1} contract generated files (4 declarations and schema digests; profile 0.1).`);
