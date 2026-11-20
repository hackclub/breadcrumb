import { expect, test } from "bun:test";
import { redactTelemetryURL } from "../lib/telemetry";

test("performance metrics exclude auth parameters, fragments and profile identities", () => {
  expect(
    redactTelemetryURL({ url: "https://breadcrumb.example/?token=private#code", value: 12 }),
  ).toEqual({ url: "https://breadcrumb.example/", value: 12 });
  expect(
    redactTelemetryURL({ url: "https://breadcrumb.example/u/someone?email=private" })?.url,
  ).toBe("https://breadcrumb.example/u/[username]");
  expect(redactTelemetryURL({ url: "https://user:secret@breadcrumb.example/profile" })?.url).toBe(
    "https://breadcrumb.example/profile",
  );
  expect(redactTelemetryURL({ url: "not a valid URL" })).toBeNull();
});
