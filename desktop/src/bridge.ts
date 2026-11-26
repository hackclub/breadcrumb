import type { AgentStatus, AgentUsage } from "./agent-usage-types";
import { invoke } from "@tauri-apps/api/core";
import type { State, Payload } from "./types";
const native = Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
export const isNative = native;
export const defaultServer = "https://breadcrumb.hackclub.com/";
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
const demoAgentUpload = {
  enabled: false,
  connected: false,
  server: "https://breadcrumb.example",
  lastSynced: "",
  error: "",
  signingIn: false,
  authError: "",
};
const demoAgentStatus: AgentStatus = {
  providers: [
    { id: "claude", name: "Claude Code", detected: true, enabled: false },
    { id: "codex", name: "Codex", detected: true, enabled: false },
    { id: "import", name: "JSONL plugins", detected: false, enabled: false },
  ],
  lastScan: new Date().toISOString(),
  pending: 0,
  bytes: 0,
};
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
    maximumWidth: 1280,
    idleMinutes: 5,
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
    idle: true,
  },
  exclusions: [],
  directory: "Synthetic preview",
  server: "https://breadcrumb.example",
  connected: true,
  sync: {
    email: "preview@example.invalid",
    enabled: true,
    paused: false,
    uploaded: 8,
    pending: 4,
    etaSeconds: 20,
    uploading: true,
    error: "",
    failed: 0,
    lastSynced: new Date().toISOString(),
    signingIn: false,
    authError: "",
    parallelism: 4,
    capturesPerSecond: 0.2,
    bytesPerSecond: 98304,
    bytesSent: 786432,
    sessionUploaded: 8,
    imagesReused: 3,
    active: [{ id: "preview-upload", app: "Editor", date: Date.now() / 1000 - 978307200 }],
  },
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
  if (command === "appIcon") return { icon: "" } as T;
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
  if (command === "agentUsageSync") {
    const input = args as { enabled?: boolean; disconnect?: boolean };
    if (typeof input.enabled === "boolean") demoAgentUpload.enabled = input.enabled;
    if (input.disconnect) {
      demoAgentUpload.connected = false;
      demoAgentUpload.enabled = false;
    }
    return structuredClone(demoAgentUpload) as T;
  }
  if (command === "beginAgentSignIn") {
    demoAgentUpload.connected = true;
    demoAgentUpload.enabled = true;
    return { url: "https://breadcrumb.example/agents" } as T;
  }
  if (command === "agentUsageSettings" || command === "agentUsage") {
    try {
      const enabled = JSON.parse(
        localStorage.getItem("breadcrumb-demo-agent-providers") ?? "[]",
      ) as string[];
      for (const p of demoAgentStatus.providers) p.enabled = enabled.includes(p.id);
    } catch {}
  }
  if (command === "agentUsageSettings") {
    const input = args as { provider?: string; enabled?: boolean };
    const provider = demoAgentStatus.providers.find((p) => p.id === input?.provider);
    if (provider) {
      provider.enabled = Boolean(input.enabled);
      localStorage.setItem(
        "breadcrumb-demo-agent-providers",
        JSON.stringify(demoAgentStatus.providers.filter((p) => p.enabled).map((p) => p.id)),
      );
    }
    return structuredClone(demoAgentStatus) as T;
  }
  if (command === "agentUsage") {
    const input = args as { range: number; timeZone: string };
    const hours: AgentUsage["hours"] = [];
    for (let d = 0; d < input.range; d++)
      for (const [i, p] of demoAgentStatus.providers.entries())
        if (p.enabled && p.id !== "import")
          hours.push({
            provider: p.id,
            model: i === 0 ? "claude-sonnet-4-6" : "gpt-5.4",
            project: "Example project",
            hour: new Date(Date.now() - d * 86400000).toISOString(),
            input: 20000 + d * 1000,
            cacheRead: 80000,
            cacheWrite: i === 0 ? 10000 : 0,
            cacheWrite1h: 0,
            output: 4000,
            reasoning: 0,
            events: 3,
          });
    return {
      status: structuredClone(demoAgentStatus),
      hours,
      sessions: hours.map((h, i) => ({
        provider: h.provider,
        id: `synthetic-${i}`,
        model: h.model,
        project: h.project,
        start: h.hour,
        end: h.hour,
        events: 3,
      })),
      timeZone: input.timeZone,
    } as T;
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
  if (command === "syncOptions" && demoState.sync) {
    const input = args as { paused?: boolean; concurrency?: number; retry?: boolean };
    if (input.paused !== undefined) {
      demoState.sync.paused = input.paused;
      demoState.sync.uploading = !input.paused;
      demoState.sync.active = input.paused
        ? []
        : [{ id: "preview-upload", app: "Editor", date: now }];
    }
    if (input.concurrency !== undefined) demoState.sync.parallelism = input.concurrency;
    if (input.retry) {
      demoState.sync.error = "";
      demoState.sync.failed = 0;
    }
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
