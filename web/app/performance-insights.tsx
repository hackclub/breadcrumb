"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { redactTelemetryURL } from "../lib/telemetry";

export function PerformanceInsights() {
  return <SpeedInsights beforeSend={redactTelemetryURL} />;
}
