// Bundled 64px marks in public/app-icons, so viewing usage never requests third-party images.
const AGENTS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
};
const MODELS: [RegExp, string][] = [
  [/^claude/, "claude"],
  [/^(gpt|o\d|codex)/, "openai"],
  [/^grok/, "grok"],
  [/^gemini/, "gemini"],
  [/^glm/, "zai"],
  [/^mercury/, "inception"],
];

/** Icon path for a coding agent's usage ID, or null for plugins and unknown agents. */
export function agentIcon(id: string) {
  return id in AGENTS ? `/app-icons/${AGENTS[id]}.png` : null;
}

/** Icon path for the company that makes a model, or null when the family is unknown. */
export function modelIcon(model: string) {
  const name = model.toLowerCase().split("/").at(-1) ?? "";
  const match = MODELS.find(([pattern]) => pattern.test(name));
  return match ? `/app-icons/${match[1]}.png` : null;
}
