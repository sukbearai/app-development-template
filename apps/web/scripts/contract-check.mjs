import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";
import { appRouter } from "@pstack/server/trpc-router";
import { handleTrpcRequest } from "@pstack/server/trpc-handler";
import * as trpcRoute from "../app/api/trpc/[trpc]/route.ts";
import { jsonSchema } from "@pstack/contracts/openapi";
import { apiRoutes, buildOpenApiDocument, buildApiMarkdown } from "./api-contracts.mjs";

const webRoot = new URL("../", import.meta.url);
const root = new URL("../../", webRoot);
const trpcRouteFile = "app/api/trpc/[trpc]/route.ts";
const fallbackRouteFile = "app/api/[...segments]/route.ts";
const expectedProcedures = {
  "auth.login": "mutation",
  "auth.me": "query",
  "auth.logout": "mutation",
  "auth.changePassword": "mutation",
  "users.list": "query",
  "users.create": "mutation",
  "users.update": "mutation",
  "users.resetPassword": "mutation",
  "roles.list": "query",
  "roles.create": "mutation",
  "roles.update": "mutation",
  "audit.list": "query",
  "outbox.list": "query",
  "runtime.health": "query",
};
const inputlessProcedures = new Set([
  "auth.me",
  "auth.logout",
  "roles.list",
  "outbox.list",
  "runtime.health",
]);
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

async function listRouteFiles(directory, prefix = "app/api") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await listRouteFiles(new URL(`${entry.name}/`, directory), relative)));
    else if (entry.name === "route.ts") files.push(relative);
  }
  return files.sort();
}

function exportedMethods(source, filename) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const exports = [];
  for (const statement of parsed.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      exports.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) exports.push(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      exports.push(
        ...statement.declarationList.declarations.flatMap((declaration) =>
          ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
        ),
      );
    }
  }
  return exports.filter((name) => methods.has(name)).sort();
}

const [routeFiles, openapiText, apiMarkdown] = await Promise.all([
  listRouteFiles(new URL("app/api/", webRoot)),
  readFile(new URL("docs/openapi.json", root), "utf8"),
  readFile(new URL("docs/api.md", root), "utf8"),
]);
const document = JSON.parse(openapiText);
assert.deepEqual(document, buildOpenApiDocument(), "docs/openapi.json is stale; run pnpm api:docs");
assert.equal(apiMarkdown, buildApiMarkdown(), "docs/api.md is stale; run pnpm api:docs");
assert.equal(
  new Set(apiRoutes.map((operation) => operation.operationId)).size,
  apiRoutes.length,
  "Duplicate operation ID",
);
assert.equal(
  new Set(apiRoutes.map((operation) => `${operation.method} ${operation.path}`)).size,
  apiRoutes.length,
  "Duplicate HTTP operation",
);
assert.ok(routeFiles.includes(trpcRouteFile), "tRPC adapter route is missing");
assert.ok(routeFiles.includes(fallbackRouteFile), "Not-found fallback route is missing");
assert.deepEqual(
  routeFiles.filter((file) => file.includes("[")),
  [fallbackRouteFile, trpcRouteFile].sort(),
  "Only the registered tRPC route and not-found fallback may be dynamic",
);
assert.equal(trpcRoute.GET, handleTrpcRequest, "tRPC GET must bind the real fetch adapter");
assert.equal(trpcRoute.POST, handleTrpcRequest, "tRPC POST must bind the real fetch adapter");
const procedures = appRouter._def.procedures;
assert.deepEqual(
  Object.keys(procedures).sort(),
  Object.keys(expectedProcedures).sort(),
  "tRPC procedure inventory changed",
);
for (const [name, type] of Object.entries(expectedProcedures)) {
  const definition = procedures[name]._def;
  assert.equal(definition.type, type, `${name}: unexpected procedure type`);
  assert.ok(definition.output, `${name}: output validation is missing`);
  assert.equal(
    definition.output.safeParse({}).success,
    false,
    `${name}: output parser accepts an empty response`,
  );
  assert.equal(
    definition.inputs.length,
    inputlessProcedures.has(name) ? 0 : 1,
    `${name}: input parser count changed`,
  );
}
const explicit = routeFiles.filter((file) => file !== fallbackRouteFile && file !== trpcRouteFile);
assert.deepEqual(
  [...new Set(apiRoutes.map((operation) => operation.routeFile))].sort(),
  explicit,
  "HTTP registry must list every explicit route file",
);

for (const file of routeFiles) {
  const source = await readFile(new URL(file, webRoot), "utf8");
  if (file === fallbackRouteFile) {
    assert.match(source, /ROUTE_NOT_FOUND/, "catch-all must remain a not-found fallback");
    continue;
  }
  if (file === trpcRouteFile) {
    assert.deepEqual(
      exportedMethods(source, file),
      ["GET", "POST"],
      "tRPC must expose only GET and POST",
    );
    continue;
  }
  const operations = apiRoutes.filter((operation) => operation.routeFile === file);
  assert.deepEqual(
    exportedMethods(source, file),
    operations.map((operation) => operation.method).sort(),
    `${file}: method exports differ from registry`,
  );
  for (const operation of operations) {
    assert.equal(
      file,
      `app${operation.path.replace(/\{([^}]+)\}/g, "[$1]")}/route.ts`,
      "Route path does not match its file",
    );
    if (operation.request) {
      assert.deepEqual(
        document.components.schemas[operation.request.name],
        jsonSchema(operation.request.schema, "input"),
        `${operation.operationId}: request schema name collides with another definition`,
      );
    }
    for (const [status, response] of Object.entries(operation.responses)) {
      const definition = document.components.schemas[response.name];
      assert.deepEqual(
        definition,
        jsonSchema(response.schema, "output"),
        `${operation.operationId} ${status}: response schema name collides with another definition`,
      );
      assert.equal(
        definition.type,
        "object",
        `${operation.operationId} ${status}: response must have a concrete shape`,
      );
      if (Number(status) < 400 && operation.path !== "/api/hello") {
        assert.ok(definition.required.includes("data"));
        assert.ok(
          definition.properties.data.type ||
            definition.properties.data.$ref ||
            definition.properties.data.anyOf,
          `${operation.operationId} ${status}: success data must be typed`,
        );
      }
      assert.equal(
        response.schema.safeParse({}).success,
        false,
        `${operation.operationId} ${status}: empty response accepted`,
      );
    }
  }
}
console.log(
  `contract check ok (${apiRoutes.length} external REST operations; ${Object.keys(procedures).length} tRPC procedures; route methods, adapter bindings, generated inputs and outputs)`,
);
