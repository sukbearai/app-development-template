import { jsonRecordSchema } from "@pstack/contracts/primitives";

export function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Stored JSON columns are validated against the contracts object schema.
export function jsonObject(value: unknown) {
  const parsed = jsonRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function containsText(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
