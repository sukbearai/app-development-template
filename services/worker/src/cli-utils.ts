// oxlint-disable-next-line anti-slop/no-unknown-parameters -- CLI output serializes command-specific values without inspecting their shape.
export function printJson(value: unknown) {
  console.log(JSON.stringify(value));
}

export function flagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function flagEnabled(args: string[], flag: string) {
  return args.includes(flag);
}

export function numberFlag(args: string[], flag: string) {
  const value = Number(flagValue(args, flag));
  return Number.isFinite(value) ? value : undefined;
}
