"use client";
import { useEffect, useState } from "react";
import { calendarClock, REFERENCE } from "../lib/insights";
import { estimate, processedTokens } from "../lib/agent-pricing";
import type { AgentUsage, AgentHour } from "../lib/agent-usage-types";
import { agentIcon, modelIcon } from "../lib/agent-icons";
import "./agent-usage.css";
const count = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
function Mark({ icon, name }: { icon: string | null; name: string }) {
  return icon ? (
    <img className="catalog-app-icon" src={icon} alt="" width="22" height="22" />
  ) : (
    <span className="app-monogram" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function AgentUsageView({
  loadUsage,
  remote = false,
}: {
  loadUsage: (range: number, timeZone: string) => Promise<AgentUsage>;
  remote?: boolean;
}) {
  const [range, setRange] = useState(7),
    [metric, setMetric] = useState("cost"),
    [by, setBy] = useState("model"),
    [data, setData] = useState<AgentUsage | null>(null),
    [error, setError] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), []);
  useEffect(() => {
    let live = true;
    setData(null);
    const load = () =>
      loadUsage(range, timeZone)
        .then((d) => {
          if (live) {
            setData(d);
            setError("");
          }
        })
        .catch(() => {
          if (live) setError("Could not load coding-agent usage.");
        });
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [range, timeZone, loadUsage]);
  const hours = data?.hours ?? [],
    tokens = hours.reduce((n, h) => n + processedTokens(h), 0),
    cost = hours.reduce((n, h) => n + (estimate(h, h.model)?.cost ?? 0), 0),
    savings = hours.reduce((n, h) => n + (estimate(h, h.model)?.savings ?? 0), 0);
  const clock = calendarClock(timeZone),
    dayByHour = new Map<string, string>();
  for (const h of hours)
    if (!dayByHour.has(h.hour))
      dayByHour.set(h.hour, clock(Date.parse(h.hour) / 1000 - REFERENCE).day);
  const day = (h: AgentHour) => dayByHour.get(h.hour)!;
  const agents = Array.from(
    new Set([
      ...(data?.status.providers
        .filter((p) => p.enabled)
        .map((p) => p.usageID ?? p.id)
        .filter(Boolean) ?? []),
      ...hours.map((h) => h.provider),
    ]),
  );
  const label = (a: string) =>
    data?.status.providers.find((p) => (p.usageID ?? p.id) === a)?.name ?? a;
  const days = Array.from(
    new Set(
      Array.from(
        { length: range * 24 + 1 },
        (_, i) => clock((Date.now() - i * 3600000) / 1000 - REFERENCE).day,
      ),
    ),
  ).sort();
  const amount = (rows: AgentHour[]) =>
    rows.reduce(
      (n, h) => n + (metric === "cost" ? (estimate(h, h.model)?.cost ?? 0) : processedTokens(h)),
      0,
    );
  const format = metric === "cost" ? money : count;
  const keys = Array.from(new Set(hours.map((h) => (by === "model" ? h.model : day(h))))).sort();
  const max = Math.max(
    1,
    ...days.flatMap((d) =>
      agents.map((a) => amount(hours.filter((h) => day(h) === d && h.provider === a))),
    ),
  );
  return (
    <section className="agent-usage" aria-busy={!data && !error}>
      <div className="insights-toolbar">
        <div>
          <h1>Coding agents</h1>
          <p className="muted">
            {remote ? "Synced token usage" : "Local token usage"} · API estimate, not your
            subscription bill
          </p>
        </div>
      </div>
      <div className="agent-controls">
        {["cost", "tokens"].map((m) => (
          <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)}>
            {m === "cost" ? "Cost" : "Tokens"}
          </button>
        ))}
        <label>
          Range{" "}
          <select
            aria-label="Range"
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
          >
            {[
              [1, "Past 24h"],
              [7, "Past 7 days"],
              [30, "Past 30 days"],
              [90, "Past 90 days"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status" className="agent-progress">
        {error ||
          (!data
            ? "Loading usage…"
            : data.status.pending
              ? `Scanning history · ${count(data.status.bytes)} bytes processed · ${data.status.pending} files pending`
              : !hours.length
                ? remote
                  ? "No usage synced yet. Connect token usage in desktop Settings to begin."
                  : "No usage yet. Enable providers in Settings to begin."
                : "Usage reflects available local history.")}
      </p>
      <div className="agent-total">{data ? format(metric === "cost" ? cost : tokens) : "—"}</div>
      <div className="agent-list">
        {(data ? agents : ["claude", "codex"]).map((a) => {
          const rows = hours.filter((h) => h.provider === a),
            value = amount(rows),
            total = metric === "cost" ? cost : tokens;
          const sessions = data
            ? count(
                remote
                  ? rows.reduce((n, h) => n + (h.sessions ?? 0), 0)
                  : new Set(data.sessions.filter((s) => s.provider === a).map((s) => s.id)).size,
              )
            : "—";
          return (
            <div className="agent-row" key={data ? a : `loading-${a}`}>
              <strong className="agent-name">
                <Mark icon={agentIcon(a)} name={label(a)} />
                {label(a)}
              </strong>
              <span>{`${sessions} ${remote ? "sessions started" : "sessions"}`}</span>
              <span>{`${total ? ((value / total) * 100).toFixed(1) : "0"}%`}</span>
              <span>{`${data ? count(rows.reduce((n, h) => n + processedTokens(h), 0)) : "—"} tokens`}</span>
              <span>
                {data
                  ? rows.length && rows.every((h) => !estimate(h, h.model))
                    ? "Unpriced"
                    : money(rows.reduce((n, h) => n + (estimate(h, h.model)?.cost ?? 0), 0))
                  : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="agent-chart" role="img" aria-label={`Daily ${metric} by coding agent`}>
        <svg viewBox="0 0 900 180" preserveAspectRatio="none">
          {agents.map((a, i) => (
            <polyline
              key={a}
              fill="none"
              stroke={`var(--agent-${i % 5})`}
              strokeWidth="2"
              points={days
                .map(
                  (d, j) =>
                    `${days.length === 1 ? 450 : (j / (days.length - 1)) * 880 + 10},${170 - (amount(hours.filter((h) => day(h) === d && h.provider === a)) / max) * 150}`,
                )
                .join(" ")}
            />
          ))}
        </svg>
        <div className="agent-controls">
          {agents.map((a, i) => (
            <span key={a} style={{ color: `var(--agent-${i % 5})` }}>
              {label(a)}
            </span>
          ))}
        </div>
        <p className="muted">
          {`${days[0] ?? "Daily usage"} — ${days.at(-1) ?? timeZone} · ${timeZone}`}
        </p>
      </div>
      <dl className="agent-totals">
        {[
          ["Processed tokens", tokens],
          ["Cached input", hours.reduce((n, h) => n + h.cacheRead, 0)],
          ["Uncached input", hours.reduce((n, h) => n + h.input, 0)],
          ["Cache writes", hours.reduce((n, h) => n + h.cacheWrite, 0)],
          ["Output", hours.reduce((n, h) => n + h.output, 0)],
          ["Cache savings", money(savings)],
        ].map(([label, n]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{data ? (typeof n === "number" ? count(n) : n) : "—"}</dd>
          </div>
        ))}
      </dl>
      <div className="agent-controls">
        <h2>Breakdown</h2>
        <label>
          Group by{" "}
          <select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="model">Model</option>
            <option value="day">Day</option>
          </select>
        </label>
      </div>
      <div className="agent-table">
        <table>
          <thead>
            <tr>
              <th>{by === "model" ? "Model" : "Day"}</th>
              <th>Tokens</th>
              <th>API estimate</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const rows = hours.filter((h) => (by === "model" ? h.model : day(h)) === k);
              return (
                <tr key={k}>
                  <th>
                    {by === "model" && <Mark icon={modelIcon(k)} name={k} />}
                    {k}
                  </th>
                  <td>{count(rows.reduce((n, h) => n + processedTokens(h), 0))}</td>
                  <td>
                    {rows.every((h) => !estimate(h, h.model))
                      ? "Unpriced"
                      : money(rows.reduce((n, h) => n + (estimate(h, h.model)?.cost ?? 0), 0))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small-note">
        Unknown models count toward tokens and are excluded from cost shares. Estimates use standard
        API rates; service tiers, long-context surcharges and account discounts may differ. Cache
        savings compare cache reads with uncached input.
      </p>
    </section>
  );
}
