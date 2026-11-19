import { test, expect } from "bun:test";
import { classifyActivity } from "../lib/activities";

test("specific metadata refines generic labels while explicit corrections and agent labels win", () => {
  const record = {
    context: { domain: "github.com" },
    windowTitle: "Pull request #12",
    classification: { activity: "Browsing" },
  };
  expect(classifyActivity(record)).toBe("Code review");
  expect(classifyActivity({ ...record, correction: "Reading" })).toBe("Research & docs");
  expect(classifyActivity({ ...record, agentLabel: { activity: "Planning" } })).toBe("Planning");
  expect(classifyActivity({ context: { domain: "developer.mozilla.org" } })).toBe(
    "Research & docs",
  );
  expect(
    classifyActivity({
      windowTitle: "pytest test_sync.py",
      classification: { activity: "Terminal work" },
    }),
  ).toBe("Testing");
});

test("ambiguous videos and terminals are not automatically learning or productive work", () => {
  expect(classifyActivity({ context: { domain: "youtube.com" } })).toBe("Video");
  expect(classifyActivity({ classification: { activity: "Terminal work" } })).toBe("Terminal");
  expect(classifyActivity({ context: { domain: "github.com.evil.example" } })).toBe("Unclassified");
  expect(
    classifyActivity({
      context: { domain: "chatgpt.com" },
      windowTitle: "Discuss pytest test results",
    }),
  ).toBe("AI collaboration");
  expect(
    classifyActivity({ context: { domain: "docs.pytest.org" }, windowTitle: "pytest docs" }),
  ).toBe("Research & docs");
  expect(classifyActivity({})).toBe("Unclassified");
});
