import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");

test("the native shell allows every engine command the desktop UI sends", () => {
  const rust = readFileSync(join(desktop, "src-tauri/src/main.rs"), "utf8");
  const list = rust.match(/let commands = \[([\s\S]*?)\];/)?.[1] ?? "";
  const allowed = new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  expect(allowed.size).toBeGreaterThan(0);
  const sent = new Set<string>();
  for (const file of readdirSync(join(desktop, "src")).filter((f) => /\.tsx?$/.test(f)))
    for (const m of readFileSync(join(desktop, "src", file), "utf8").matchAll(
      /\bengine(?:<[^>]*>)?\(\s*"([^"]+)"/g,
    ))
      sent.add(m[1]);
  expect(sent.size).toBeGreaterThan(0);
  expect([...sent].filter((c) => !allowed.has(c))).toEqual([]);
});
