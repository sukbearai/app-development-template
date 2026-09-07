import { getTableConfig, PgTable, PgDialect } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import type { PoolClient } from "pg";
import * as schema from "./schema";
import { z } from "zod";

const dialect = new PgDialect();
function expression(value: string) {
  const tokens =
    value.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|::|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g,
    ) || [];
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      token === "::" &&
      ["text", "jsonb", "integer", "bigint", "boolean"].includes(tokens[i + 1])
    ) {
      i++;
      if (tokens[i + 1] === "[" && tokens[i + 2] === "]") i += 2;
      continue;
    }
    if (token.startsWith('"') && tokens[i + 1] === ".") {
      i++;
      continue;
    }
    result.push(
      token.startsWith('"')
        ? token.slice(1, -1).replaceAll('""', '"')
        : token.startsWith("'")
          ? token
          : token.toLowerCase(),
    );
  }
  return JSON.stringify(result);
}
function checkExpression(value: string) {
  let tokens: string[] = JSON.parse(expression(value));
  while (tokens[0] === "(" && tokens.at(-1) === ")") {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i] === "(") depth++;
      if (tokens[i] === ")") depth--;
      if (depth === 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    tokens = tokens.slice(1, -1);
  }
  let values: string[] | undefined;
  if (tokens[1] === "in" && tokens[2] === "(" && tokens.at(-1) === ")")
    values = tokens.slice(3, -1);
  if (
    tokens[1] === "=" &&
    tokens[2] === "any" &&
    tokens[3] === "(" &&
    tokens[4] === "array" &&
    tokens[5] === "[" &&
    tokens.at(-2) === "]" &&
    tokens.at(-1) === ")"
  )
    values = tokens.slice(6, -2);
  if (
    values?.length &&
    values.every((token, index) =>
      index % 2 === 0 ? /^'(?:''|[^'])*'$/.test(token) : token === ",",
    )
  )
    return JSON.stringify([tokens[0], "in", values]);
  return JSON.stringify(tokens);
}
function sameColumns(left: string[], right: string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}
const actions: Record<string, string> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

const names = z.array(z.string());
const keySchema = z.object({ name: z.string(), columns: names });
const tableSnapshotSchema = z.object({
  name: z.string(),
  columns: z.record(
    z.string(),
    z.object({
      name: z.string(),
      type: z.string(),
      notNull: z.boolean(),
      primaryKey: z.boolean(),
      default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
  ),
  compositePrimaryKeys: z.record(z.string(), keySchema),
  uniqueConstraints: z.record(z.string(), keySchema),
  foreignKeys: z.record(
    z.string(),
    z.object({
      name: z.string(),
      tableTo: z.string(),
      columnsFrom: names,
      columnsTo: names,
      onUpdate: z.string().default("no action"),
      onDelete: z.string().default("no action"),
    }),
  ),
  checkConstraints: z
    .record(z.string(), z.object({ name: z.string(), value: z.string() }))
    .default({}),
  indexes: z.record(
    z.string(),
    z.object({
      name: z.string(),
      isUnique: z.boolean(),
      method: z.string(),
      where: z.string().optional(),
      columns: z.array(
        z.object({
          expression: z.string(),
          asc: z.boolean(),
          nulls: z.enum(["first", "last"]),
        }),
      ),
    }),
  ),
});
const snapshotSchema = z.object({
  tables: z.record(z.string(), tableSnapshotSchema),
});
type SnapshotTable = z.infer<typeof tableSnapshotSchema>;
function currentTables(): SnapshotTable[] {
  return Object.values(schema)
    .filter((table) => is(table, PgTable))
    .map((table) => {
      const config = getTableConfig(table);
      return {
        name: config.name,
        columns: Object.fromEntries(
          config.columns.map((column) => [
            column.name,
            {
              name: column.name,
              type: column.getSQLType(),
              notNull: column.notNull,
              primaryKey: column.primary,
              default:
                column.default === undefined
                  ? undefined
                  : is(column.default, SQL)
                    ? dialect.sqlToQuery(column.default).sql
                    : typeof column.default === "string"
                      ? `'${column.default.replaceAll("'", "''")}'`
                      : typeof column.default === "object"
                        ? `'${JSON.stringify(column.default)}'`
                        : String(column.default),
            },
          ]),
        ),
        compositePrimaryKeys: Object.fromEntries(
          config.primaryKeys.map((key) => [
            key.getName(),
            {
              name: key.getName(),
              columns: key.columns.map((column) => column.name),
            },
          ]),
        ),
        uniqueConstraints: Object.fromEntries(
          [
            ...config.uniqueConstraints.map((key) => ({
              name:
                key.getName() ||
                key.columns.map((column) => column.name).join("_"),
              columns: key.columns.map((column) => column.name),
            })),
            ...config.columns
              .filter((column) => column.isUnique)
              .map((column) => ({
                name: column.uniqueName,
                columns: [column.name],
              })),
          ].map((key) => [key.name, key]),
        ),
        foreignKeys: Object.fromEntries(
          config.foreignKeys.map((key) => {
            const reference = key.reference();
            return [
              key.getName(),
              {
                name: key.getName(),
                tableTo: getTableConfig(reference.foreignTable).name,
                columnsFrom: reference.columns.map((column) => column.name),
                columnsTo: reference.foreignColumns.map(
                  (column) => column.name,
                ),
                onUpdate: key.onUpdate || "no action",
                onDelete: key.onDelete || "no action",
              },
            ];
          }),
        ),
        checkConstraints: Object.fromEntries(
          config.checks.map((check) => [
            check.name,
            { name: check.name, value: dialect.sqlToQuery(check.value).sql },
          ]),
        ),
        indexes: Object.fromEntries(
          config.indexes.map(({ config: index }) => [
            index.name,
            {
              name: index.name,
              isUnique: index.unique,
              method: index.method,
              where: index.where
                ? dialect.sqlToQuery(index.where).sql
                : undefined,
              columns: index.columns.map((column) => {
                if (is(column, SQL))
                  return {
                    expression: dialect.sqlToQuery(column).sql,
                    asc: true,
                    nulls: "last" as const,
                  };
                if (!("name" in column) || !column.name)
                  throw new Error("Index column cannot be inspected");
                return {
                  expression: column.name,
                  asc: column.indexConfig?.order !== "desc",
                  nulls: column.indexConfig?.nulls || "last",
                };
              }),
            },
          ]),
        ),
      };
    });
}
export async function assertDatabaseSnapshot(
  connection: Pick<PoolClient, "query">,
  snapshot: unknown,
) {
  return assertTables(
    connection,
    Object.values(snapshotSchema.parse(snapshot).tables),
  );
}
export async function assertDatabaseSchema(
  connection: Pick<PoolClient, "query">,
) {
  return assertTables(connection, currentTables());
}
async function assertTables(
  connection: Pick<PoolClient, "query">,
  tables: SnapshotTable[],
) {
  const result = await connection.query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
    data_type: string;
    column_default: string | null;
  }>(
    "select table_name,column_name,is_nullable,data_type,column_default from information_schema.columns where table_schema='public'",
  );
  const constraints = await connection.query<{
    table_name: string;
    name: string;
    kind: string;
    columns: string[];
    foreign_table: string | null;
    foreign_schema: string | null;
    foreign_columns: string[];
    update_action: string;
    delete_action: string;
    valid: boolean;
    deferrable: boolean;
    definition: string;
  }>(`select rel.relname as table_name,c.conname as name,c.contype as kind,
    array(select a.attname::text from unnest(c.conkey) with ordinality k(num,pos) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.pos) as columns,
    foreign_rel.relname as foreign_table, foreign_ns.nspname as foreign_schema,
    array(select a.attname::text from unnest(c.confkey) with ordinality k(num,pos) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.pos) as foreign_columns,
    c.confupdtype as update_action,c.confdeltype as delete_action,c.convalidated as valid,c.condeferrable as deferrable,pg_get_constraintdef(c.oid,true) as definition
    from pg_constraint c join pg_class rel on rel.oid=c.conrelid join pg_namespace ns on ns.oid=rel.relnamespace
    left join pg_class foreign_rel on foreign_rel.oid=c.confrelid left join pg_namespace foreign_ns on foreign_ns.oid=foreign_rel.relnamespace where ns.nspname='public'`);
  const indexes = await connection.query<{
    table_name: string;
    name: string;
    unique: boolean;
    valid: boolean;
    method: string;
    predicate: string | null;
    columns: string[];
    included: number;
  }>(`select rel.relname as table_name,idx.relname as name,i.indisunique as unique,i.indisvalid as valid,am.amname as method,pg_get_expr(i.indpred,i.indrelid) as predicate,
    array(select pg_get_indexdef(i.indexrelid,n,true) from generate_series(1,i.indnkeyatts) n) as columns,(i.indnatts-i.indnkeyatts) as included
    from pg_index i join pg_class rel on rel.oid=i.indrelid join pg_class idx on idx.oid=i.indexrelid join pg_namespace ns on ns.oid=rel.relnamespace join pg_am am on am.oid=idx.relam where ns.nspname='public'`);
  const columns = new Map(
    result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  for (const config of tables) {
    const actualConstraints = constraints.rows.filter(
      (row) => row.table_name === config.name,
    );
    function requireKey(kind: "p" | "u", names: string[]) {
      if (
        !actualConstraints.some(
          (row) =>
            row.kind === kind &&
            row.valid &&
            !row.deferrable &&
            sameColumns(row.columns, names),
        )
      )
        throw new Error(
          `Database schema differs at ${config.name}: missing ${kind === "p" ? "primary key" : "unique constraint"} (${names.join(",")})`,
        );
    }
    for (const column of Object.values(config.columns)) {
      const key = `${config.name}.${column.name}`;
      const actual = columns.get(key);
      if (!actual) throw new Error(`Database schema is missing ${key}`);
      if (
        actual.data_type !== column.type ||
        (actual.is_nullable === "NO") !== column.notNull
      )
        throw new Error(`Database schema differs at ${key}`);
      const expectedDefault =
        column.default === undefined ? null : String(column.default);
      if (
        (expectedDefault === null) !== (actual.column_default === null) ||
        (expectedDefault !== null &&
          actual.column_default !== null &&
          expression(expectedDefault) !== expression(actual.column_default))
      )
        throw new Error(`Database schema differs at ${key}: default`);
      if (column.primaryKey) requireKey("p", [column.name]);
    }
    for (const key of Object.values(config.compositePrimaryKeys))
      requireKey("p", key.columns);
    for (const key of Object.values(config.uniqueConstraints))
      requireKey("u", key.columns);
    for (const foreign of Object.values(config.foreignKeys)) {
      if (
        !actualConstraints.some(
          (row) =>
            row.kind === "f" &&
            row.valid &&
            !row.deferrable &&
            row.foreign_schema === "public" &&
            row.foreign_table === foreign.tableTo &&
            sameColumns(row.columns, foreign.columnsFrom) &&
            sameColumns(row.foreign_columns, foreign.columnsTo) &&
            actions[row.update_action] === (foreign.onUpdate || "no action") &&
            actions[row.delete_action] === (foreign.onDelete || "no action"),
        )
      )
        throw new Error(
          `Database schema differs at ${config.name}: foreign key ${foreign.name}`,
        );
    }
    for (const check of Object.values(config.checkConstraints)) {
      const actual = actualConstraints.find(
        (row) => row.kind === "c" && row.name === check.name,
      );
      if (
        !actual?.valid ||
        checkExpression(actual.definition.replace(/^CHECK\s*/i, "")) !==
          checkExpression(check.value)
      )
        throw new Error(
          `Database schema differs at ${config.name}: check ${check.name}`,
        );
    }
    for (const index of Object.values(config.indexes)) {
      const actual = indexes.rows.find(
        (row) => row.table_name === config.name && row.name === index.name,
      );
      const expectedColumns = index.columns.map((column) =>
        expression(
          `${column.expression}${!column.asc ? " desc" : ""}${column.nulls === "first" ? " nulls first" : ""}`,
        ),
      );
      if (
        !actual?.valid ||
        actual.unique !== index.isUnique ||
        actual.method !== index.method ||
        actual.included !== 0 ||
        !sameColumns(actual.columns.map(expression), expectedColumns) ||
        expression(actual.predicate || "") !== expression(index.where || "")
      )
        throw new Error(
          `Database schema differs at ${config.name}: index ${index.name}`,
        );
    }
  }
}
