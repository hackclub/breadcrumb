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
