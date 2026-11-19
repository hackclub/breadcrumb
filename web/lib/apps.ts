import seed from "./app-seed.json";
import type { Breakdown } from "./insights";
export type AppEntry = {
  id: string;
  name: string;
  aliases: string[];
  icon: string;
  source: string;
};
export const appSeed: AppEntry[] = seed;
const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\.(exe|app)$/, "");
export function findApp(apps: AppEntry[], name: string, id?: string) {
  return (
    apps.find((app) =>
      [app.id, app.name, ...app.aliases].some(
        (alias) => normalize(alias) === normalize(id || name),
      ),
    ) ??
    apps.find((app) =>
      [app.id, app.name, ...app.aliases].some((alias) => normalize(alias) === normalize(name)),
    )
  );
}

export function mergeApps(rows: Breakdown, apps: AppEntry[] = appSeed): Breakdown {
  const totals = new Map<string, Breakdown[number]>();
  for (const row of rows) {
    const app = findApp(apps, row.name, row.id);
    const key = app
      ? `app:${app.id}`
      : row.id
        ? `id:${normalize(row.id)}`
        : `name:${normalize(row.name)}`;
    totals.set(key, {
      ...row,
      ...(app ? { id: app.id, name: app.name } : {}),
      seconds: (totals.get(key)?.seconds ?? 0) + row.seconds,
    });
  }
  return [...totals.values()].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}
