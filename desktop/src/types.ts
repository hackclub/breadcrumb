export type Settings = {
  retentionHours: number;
  storageGiB: number;
  savedStorageGiB: number;
  intervalSeconds: number;
  captureChanges: boolean;
  minimumEventInterval: number;
  recognizeText: boolean;
  jpegQuality: number;
  maximumWidth: number;
  idleMinutes: number;
};
export type Capture = {
  id: string;
  date: number;
  sampleIntervalSeconds?: number;
  app: string;
  bundleID: string;
  windowTitle: string;
  correction?: string;
  agentLabel?: { activity: string; reason: string; flags: string[] };
  classification?: { activity: string; reason: string };
  context?: { domain?: string; project?: string; document?: string };
  visibleWindows?: {
    windowID: number | string;
    app: string;
    bundleID?: string;
    title: string;
    focused: boolean;
  }[];
  treeStatus?: string;
};
export type Clip = { id: string; name: string; created: number; frameIDs: string[] };
export type Session = {
  id: string;
  title: string;
  start: number;
  end: number;
  ids: string[];
  activities: string[];
};
export type State = {
  recording: boolean;
  status: string;
  settings: Settings;
  observations: Capture[];
  clips: Clip[];
  sessions: Session[];
  historyBytes: number;
  savedBytes: number;
  capabilities: {
    screenshot: boolean;
    accessibility: boolean;
    ocr: boolean;
    windowContext: boolean;
    exclusions: string;
    backend: string;
    permission: string;
    /** Whether the backend reports time since the last input. */
    idle?: boolean;
    desktopIntegration?: string;
  };
  exclusions: string[];
  directory: string;
  server: string;
  connected: boolean;
  sync?: {
    email: string;
    enabled: boolean;
    uploaded: number;
    pending: number;
    etaSeconds?: number | null;
    paused?: boolean;
    active?: { id: string; app: string; date: number }[];
    parallelism?: number;
    capturesPerSecond?: number;
    bytesPerSecond?: number;
    bytesSent?: number;
    sessionUploaded?: number;
    imagesReused?: number;
    retryAt?: string;
    uploading: boolean;
    error: string;
    failed: number;
    lastSynced: string;
    signingIn: boolean;
    authError: string;
  };
  demo: boolean;
};
export type Payload = {
  jpeg: string;
  tree: { role: string; label?: string; depth: number }[];
  screenText?: string;
};
export const activities = [
  "Coding",
  "Terminal work",
  "Reading",
  "Video page",
  "Meeting app",
  "Messaging interface",
  "AI assistant page",
  "Social page",
  "Calendar interface",
  "Developer page",
  "Browser settings",
  "Browsing",
  "Music app",
  "Email app",
  "Unclassified",
];
export const date = (value: number) => new Date((value + 978307200) * 1000);
export const timestamp = (value: Date) => value.getTime() / 1000 - 978307200;
export const activity = (r: Capture) =>
  r.correction || r.agentLabel?.activity || r.classification?.activity || "Unclassified";
export const shortActivity = (v: string) =>
  ({
    "Terminal work": "Terminal",
    "Video page": "Video",
    "Meeting app": "Meetings",
    "Messaging interface": "Messaging",
    "AI assistant page": "AI assistants",
    "Social page": "Social",
    "Calendar interface": "Calendar",
    "Developer page": "Developer sites",
    "Browser settings": "Settings",
    "Music app": "Music",
    "Email app": "Email",
    Unclassified: "Other apps",
  })[v] || v;
export const bytes = (n: number) =>
  n > 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + " GiB" : (n / 1024 ** 2).toFixed(1) + " MiB";
