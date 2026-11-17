import { invoke } from "@tauri-apps/api/core";
import type { State, Payload } from "./types";
const native = Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
export const isNative = native;
export async function withPanelDialog<T>(task: () => Promise<T> | T): Promise<T> {
  if (native) await invoke("panel_dialog", { open: true });
  try {
    return await task();
  } finally {
    if (native) await invoke("panel_dialog", { open: false });
  }
}
export const confirmAction = (message: string) => withPanelDialog(() => window.confirm(message));
export async function onPanelOpen(callback: () => void) {
  if (!native) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("panel-compact", callback);
}
export async function hidePanel() {
  if (native) await invoke("hide_panel");
}
let demoState: State = {
  recording: false,
  status: "Browser preview · synthetic data",
  settings: {
    retentionHours: 0,
    storageGiB: 20,
    savedStorageGiB: 4,
    intervalSeconds: 60,
    captureChanges: true,
    minimumEventInterval: 10,
    recognizeText: true,
    jpegQuality: 0.65,
    maximumWidth: 0,
  },
  observations: [],
  clips: [],
  sessions: [],
  historyBytes: 0,
  savedBytes: 0,
  capabilities: {
    screenshot: true,
    accessibility: true,
    ocr: true,
    windowContext: true,
    exclusions: "native-filter",
    backend: "Synthetic browser preview",
    permission: "granted",
  },
  exclusions: [],
  directory: "Synthetic preview",
  server: "https://breadcrumb.hackclub.dev",
  connected: false,
  demo: true,
};
const now = Date.now() / 1000 - 978307200;
for (let i = 0; i < 12; i++) {
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  demoState.observations.push({
    id,
    date: now - (11 - i) * 60,
    app: i % 3 === 1 ? "Browser" : "Editor",
    bundleID: i % 3 === 1 ? "example.browser" : "example.editor",
    windowTitle: i % 3 === 1 ? "Documentation" : "Context.swift — Breadcrumb",
    context: { project: "Breadcrumb" },
    classification: { activity: i % 3 === 1 ? "Reading" : "Coding", reason: "Synthetic fixture" },
    visibleWindows: [
      { windowID: 2, app: "Browser", title: "Synthetic video - YouTube", focused: false },
    ],
  });
}
demoState.sessions = [
  {
    id: demoState.observations[0].id,
    title: "Breadcrumb",
    start: now - 660,
    end: now,
    ids: demoState.observations.map((r) => r.id),
    activities: ["Coding", "Reading", "Video page"],
  },
];
export async function engine<T = State>(command: string, args: unknown = {}): Promise<T> {
  if (native) return invoke<T>("engine", { command, args });
  // Explicit browser preview never touches a real library or starts recording.
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (command === "state") return structuredClone(demoState) as T;
  if (command === "toggle")
    throw Error("Recording is only available in the installed desktop app.");
  if (command === "settings") {
    demoState = { ...demoState, settings: args as State["settings"] };
    return structuredClone(demoState) as T;
  }
  if (command === "payload") {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f0f0e6";
    ctx.fillRect(0, 0, 960, 600);
    ctx.fillStyle = "#254534";
    ctx.fillRect(640, 0, 320, 600);
    ctx.font = "24px system-ui";
    ctx.fillStyle = "#243c2d";
    ctx.fillText("SYNTHETIC DESKTOP", 40, 65);
    ctx.font = "18px system-ui";
    ctx.fillText("AI conversation / editor", 40, 110);
    ctx.fillStyle = "white";
    ctx.fillText("YouTube", 690, 65);
    ctx.fillText("alongside", 690, 100);
    return {
      jpeg: canvas.toDataURL("image/jpeg").split(",")[1],
      tree: [{ role: "AXWindow", label: "Synthetic window", depth: 0 }],
      screenText: "Synthetic preview only",
    } as Payload as T;
  }
  if (command === "correct") {
    const { id, activity } = args as { id: string; activity: string };
    demoState.observations = demoState.observations.map((r) =>
      r.id === id ? { ...r, correction: activity || undefined } : r,
    );
    return structuredClone(demoState) as T;
  }
  if (command === "save") {
    const input = args as { name: string; start: number; end: number };
    demoState.clips.push({
      id: crypto.randomUUID(),
      name: input.name,
      created: now,
      frameIDs: demoState.observations
        .filter((r) => r.date >= input.start && r.date <= input.end)
        .map((r) => r.id),
    });
    return structuredClone(demoState) as T;
  }
  if (command === "deleteClip") {
    demoState.clips = demoState.clips.filter((c) => c.id !== (args as { id: string }).id);
    return structuredClone(demoState) as T;
  }
  if (command === "exclusions") {
    demoState.exclusions = (args as { bundles: string[] }).bundles;
    return structuredClone(demoState) as T;
  }
  throw Error("This action requires the installed desktop app.");
}
