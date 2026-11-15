// 2.x -> 3.x plugin secrets report lines (protocol v1 §14.4, D74 / Q-M6-C3; M6-06).
// 2.x sealed secrets are keyed to Botling 2's own app identity and are never imported;
// M6-01d includes these lines in the import report so the user knows which plugins to re-enter.

export function secretReportLines(plugins: Array<{ name: string; secretKeys: string[] }>): string[] {
  return plugins
    .filter((plugin) => plugin.secretKeys.length > 0)
    .map((plugin) => `${plugin.name}: enter its secret settings again (Botling 2 keeps them sealed to its own app).`);
}
