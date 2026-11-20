import { test, expect } from "bun:test";
import { classifyActivity } from "../lib/activities";

test("real Windows app identities map to visible activity, including older capture aliases", () => {
  for (const [bundleID, activity] of [
    ["GitHub Desktop", "Version control"],
    ["GitHubDesktop.exe", "Version control"],
    ["VLC media player", "Video"],
    ["Steam", "Gaming"],
    ["Steam Client WebHelper", "Gaming"],
    ["Counter-Strike 2", "Gaming"],
    [
      "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe",
      "Gaming",
    ],
  ]) {
    expect(classifyActivity({ bundleID })).toBe(activity);
  }
  // Discussing an app in a browser does not mean it is running in focus.
  expect(classifyActivity({ bundleID: "Helium", windowTitle: "Steam and Counter-Strike 2" })).toBe(
    "Unclassified",
  );
  expect(classifyActivity({ bundleID: "VLC media player", correction: "Learning" })).toBe(
    "Learning",
  );
});

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
  expect(classifyActivity({ correction: "constructor" })).toBe("constructor");
  expect(classifyActivity({})).toBe("Unclassified");
});
