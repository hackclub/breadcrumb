import { expect, test } from "bun:test";
import { desktopUpdateResponse } from "../lib/desktop-updates";

const release = {
  version: "0.2.1",
  notes: "A desktop update",
  platforms: {
    "windows-x86_64": {
      url: "https://example.com/Breadcrumb.exe",
      signature: "A".repeat(80),
    },
  },
};

test("update feed selects only the requested platform and caches public metadata", async () => {
  const response = desktopUpdateResponse("windows", "x86_64", release);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    version: release.version,
    notes: release.notes,
    ...release.platforms["windows-x86_64"],
  });
  expect(response.headers.get("cache-control")).toContain("s-maxage=3600");
  expect(desktopUpdateResponse("darwin", "aarch64", release).status).toBe(204);
  expect(desktopUpdateResponse("windows", "x86_64", { ...release, platforms: {} }).status).toBe(
    204,
  );
});

test("malformed or unsigned update metadata fails closed", () => {
  for (const changes of [
    { url: "http://example.com/app.exe" },
    { url: "https://user:secret@example.com/app.exe" },
    { signature: "" },
  ]) {
    const manifest = {
      ...release,
      platforms: { "windows-x86_64": { ...release.platforms["windows-x86_64"], ...changes } },
    };
    expect(desktopUpdateResponse("windows", "x86_64", manifest).status).toBe(503);
  }
});
