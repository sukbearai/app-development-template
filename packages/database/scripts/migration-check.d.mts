export const migrationFolder: string;
export type MigrationJournal = {
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};
export function checkMigrations(options?: {
  update?: boolean;
}): Promise<MigrationJournal>;

export function assertMigrationSafety(
  journal: unknown,
  sqlFiles: string[],
  sqlByFile: Record<string, string>,
): void;
