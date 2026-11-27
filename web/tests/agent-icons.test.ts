import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { agentIcon, modelIcon } from "../lib/agent-icons";

test("agents and model families map to bundled icons", () => {
  for (const [model, icon] of [
    ["claude-opus-5-5", "claude"],
    ["claude-haiku-5-5", "claude"],
    ["gpt-6.1-sol", "openai"],
    ["gpt-6.1-sol-2026-09-29", "openai"],
    ["grok-4.7-build", "grok"],
    ["glm-5.3-flash", "zai"],
    ["gemini-3-pro", "gemini"],
    ["inception/mercury-2.5", "inception"],
  ])
    expect(modelIcon(model)).toBe(`/app-icons/${icon}.png`);
  expect(modelIcon("example-model")).toBeNull();
  for (const id of ["claude", "codex", "grok", "opencode", "antigravity"])
    expect(agentIcon(id)).toBe(`/app-icons/${id}.png`);
  expect(agentIcon("example-cli")).toBeNull();
  const paths = [
    ...["claude", "codex", "grok", "opencode", "antigravity"].map(agentIcon),
    ...["claude", "gpt", "grok", "gemini", "glm", "mercury"].map(modelIcon),
  ];
  for (const path of paths)
    expect(existsSync(new URL(`../public${path}`, import.meta.url))).toBe(true);
});
