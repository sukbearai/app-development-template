import { readFile, writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";
import { format, resolveConfig } from "prettier";
import ts from "typescript";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node scripts/generate-sdk.mjs [--check]");
}
const output = new URL("../packages/sdk/src/schema.d.ts", import.meta.url);
const schema = new URL("../docs/openapi.json", import.meta.url);
const generated = astToString(
  await openapiTS(schema, {
    inject: 'import type { jsonRecordSchema } from "@pstack/contracts/schemas";',
    transform(schemaObject) {
      if (schemaObject.format === "binary") {
        return ts.factory.createTypeReferenceNode("File");
      }
      if (
        schemaObject.type === "object" &&
        !schemaObject.properties &&
        (schemaObject.additionalProperties === true ||
          (schemaObject.additionalProperties &&
            Object.keys(schemaObject.additionalProperties).length === 0))
      ) {
        return ts.factory.createTypeReferenceNode("ReturnType", [
          ts.factory.createTypeQueryNode(
            ts.factory.createQualifiedName(
              ts.factory.createIdentifier("jsonRecordSchema"),
              "parse",
            ),
          ),
        ]);
      }
    },
  }),
);
// HTTP response header values are strings; openapi-typescript defaults undeclared headers to unknown.
const headerTypes = generated.replaceAll("[name: string]: unknown;", "[name: string]: string;");
const source = await format(headerTypes, {
  ...(await resolveConfig(output)),
  parser: "typescript",
});
if (args.includes("--check")) {
  if ((await readFile(output, "utf8")) !== source) {
    throw new Error("SDK types are stale. Run pnpm sdk:generate and include the generated file.");
  }
  console.log("SDK types match docs/openapi.json.");
} else {
  await writeFile(output, source);
  console.log("Generated packages/sdk/src/schema.d.ts.");
}
