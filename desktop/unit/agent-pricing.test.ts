import { expect, test } from "bun:test";
import { estimate, processedTokens } from "../src/agent-pricing";
const tokens = {
  input: 1e6,
  cacheRead: 1e6,
  cacheWrite: 1e6,
  cacheWrite1h: 250000,
  output: 1e6,
  reasoning: 100000,
};
test("Claude cache writes, reads and savings use distinct rates", () => {
  const result = estimate(tokens, "claude-sonnet-4-6")!;
  expect(result.cost).toBeCloseTo(3 + 0.3 + 3.75 * 0.75 + 6 * 0.25 + 15);
  expect(result.savings).toBeCloseTo(2.7);
  expect(processedTokens(tokens)).toBe(4e6);
});
test("unknown models remain unpriced", () => expect(estimate(tokens, "unknown-model")).toBeNull());
test("Codex output includes reasoning, which is not charged twice", () => {
  expect(estimate({ ...tokens, cacheWrite: 0, cacheWrite1h: 0 }, "gpt-5.4")?.cost).toBeCloseTo(
    17.75,
  );
});
test("current agent models are priced", () => {
  for (const model of ["gpt-6.1-sol", "claude-opus-5-5", "gemini-4-neon", "grok-4.7-build"])
    expect(estimate(tokens, model)).not.toBeNull();
  expect(estimate(tokens, "gpt-6.1-sol")?.cost).toBeCloseTo(2 + 0.1 + 2.5 + 10);
});
test("Grok Build fast variants cost twice the base rate", () => {
  expect(estimate(tokens, "grok-4.7-build-fast")!.cost).toBeCloseTo(
    2 * estimate(tokens, "grok-4.7-build")!.cost,
  );
});
test("dated snapshots and free models resolve", () => {
  expect(estimate(tokens, "gpt-6.1-sol-2026-09-29")?.cost).toBeCloseTo(
    estimate(tokens, "gpt-6.1-sol")!.cost,
  );
  expect(estimate(tokens, "deepseek-v4.1-flash-free")?.cost).toBe(0);
});
