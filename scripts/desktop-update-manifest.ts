import { parseArgs } from "node:util";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { updateManifest } from "../web/lib/desktop-updates";

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
    url: { type: "string" },
    signature: { type: "string" },
    notes: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.platform || !values.url || !values.signature) {
  throw Error(
    "Usage: bun scripts/desktop-update-manifest.ts --platform windows-x86_64 --url https://…/setup.exe --signature setup.exe.sig [--notes notes.md] [--output manifest.json]",
  );
}
const config = await Bun.file(
  new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url),
).json();
const output = values.output ?? fileURLToPath(new URL("../build/latest.json", import.meta.url));
const previous = (await Bun.file(output).exists()) ? await Bun.file(output).json() : {};
const signatureFile = Bun.file(values.signature);
if (signatureFile.size > 8192) throw Error("Signature file is too large");
const manifest = updateManifest.parse({
  version: config.version,
  notes: values.notes
    ? await readFile(values.notes, "utf8")
    : previous.version === config.version
      ? previous.notes
      : `Breadcrumb ${config.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    ...(previous.version === config.version ? previous.platforms : {}),
    [values.platform]: { url: values.url, signature: (await signatureFile.text()).trim() },
  },
});
await writeFile(output + ".tmp", JSON.stringify(manifest, null, 2) + "\n");
await rename(output + ".tmp", output);
console.log(`Prepared ${manifest.version} ${values.platform} update feed at ${output}`);
