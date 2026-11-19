import seed from "./app-seed.json";
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
