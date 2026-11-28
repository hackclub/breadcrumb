"use client";
// The signed-out home: what Breadcrumb records, shown with drawn examples.
// Gold only ever marks recorded time: captures, the recording light and the day track.
import { useEffect, useRef, useState, type ReactNode } from "react";

type Kind = "code" | "page" | "chat" | "term";
type Scene = {
  app: string;
  icon: string;
  title: string;
  kind: Kind;
  activity: string;
  /** A line of text read from the screen. */
  text: string;
};
// An illustrative day. Each scene is what one capture would see.
const SCENES: Scene[] = [
  {
    app: "VS Code",
    icon: "vscode",
    title: "home.tsx — breadcrumb",
    kind: "code",
    activity: "Coding",
    text: "export function Recorder() {",
  },
  {
    app: "Helium",
    icon: "helium",
    title: "Using CSS container queries",
    kind: "page",
    activity: "Research",
    text: "Container query length units",
  },
  {
    app: "Claude",
    icon: "claude",
    title: "Animating a film strip",
    kind: "chat",
    activity: "AI chat",
    text: "Use transform so nothing reflows",
  },
  {
    app: "Ghostty",
    icon: "ghostty",
    title: "bun run test",
    kind: "term",
    activity: "Testing",
    text: "42 pass, 0 fail",
  },
  {
    app: "VS Code",
    icon: "vscode",
    title: "home.css — breadcrumb",
    kind: "code",
    activity: "Coding",
    text: ".strip { overflow: hidden }",
  },
  {
    app: "Safari",
    icon: "safari",
    title: "Hack Club",
    kind: "page",
    activity: "Reading",
    text: "Hack Club is a global community",
  },
];

// Minutes since midnight.
const START = 9 * 60,
  END = 17 * 60;
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** When example capture `i` was taken: a little later each time. */
const shotTime = (i: number) => clock(START + 14 + ((i * 11) % 450));

// Line widths for each kind of window, in percent of the window body.
const CODE = [
  [0, 38],
  [6, 52],
  [6, 30],
  [12, 44],
  [12, 26],
  [6, 18],
  [0, 8],
  [0, 0],
  [0, 46],
  [6, 34],
];
const PAGE = [92, 84, 88, 40];
const CHAT: [boolean, number][] = [
  [true, 46],
  [false, 70],
  [true, 34],
  [false, 58],
];
const TERM = [30, 62, 48, 70, 22];
const LINE = "block h-[1.8cqw] shrink-0 rounded-[1cqw]";
const TONES = ["bg-raised", "bg-positive/40", "bg-danger/35"];
const HATCH =
  "bg-[repeating-linear-gradient(135deg,var(--raised)_0_3px,transparent_3px_7px)] shadow-[inset_0_0_0_1px_var(--frame)]";
const PANEL = "@container aspect-video overflow-hidden rounded-[10px] bg-preview px-[6%] pt-[5%]";

/** A drawn app window. Sizes use container units, so one drawing serves every size. */
function Window({ scene, seed = 0, still }: { scene: Scene; seed?: number; still?: boolean }) {
  const shift = (n: number) => ((n * 7 + seed * 13) % 17) - 8;
  let body: ReactNode;
  if (scene.kind === "code")
    body = CODE.map(([indent, width], i) => (
      <i
        key={i}
        className={`${LINE} ${TONES[i % 3]}`}
        style={{ marginLeft: `${indent}%`, width: width ? `${width + shift(i)}%` : 0 }}
      />
    ));
  else if (scene.kind === "page")
    body = (
      <>
        <i className="block h-[3.4cqw] w-[58%] shrink-0 rounded-[1cqw] bg-ink/40" />
        {PAGE.map((width, i) => (
          <i key={i} className={`${LINE} bg-raised`} style={{ width: `${width + shift(i)}%` }} />
        ))}
        <i className="block h-[18cqw] shrink-0 rounded-[1.4cqw] bg-raised" />
      </>
    );
  else if (scene.kind === "chat")
    body = CHAT.map(([mine, width], i) => (
      <i
        key={i}
        className={`block h-[6cqw] shrink-0 rounded-[3cqw] ${mine ? "self-end bg-ink/15" : "bg-raised"}`}
        style={{ width: `${width}%` }}
      />
    ));
  else
    body = TERM.map((width, i) => (
      <i
        key={i}
        className={`${LINE} ${i % 2 ? "bg-raised" : "bg-positive/55"}`}
        style={{ width: `${width + shift(i)}%` }}
      />
    ));
  return (
    <div
      className={`h-full overflow-hidden rounded-t-[1.8cqw] border border-b-0 border-line bg-surface ${still ? "" : "animate-window motion-reduce:animate-none"}`}
    >
      <div className="flex h-[6cqw] items-center gap-[1.4cqw] overflow-hidden border-b border-line px-[2.4cqw] text-[2.4cqw] whitespace-nowrap text-secondary">
        <span
          aria-hidden="true"
          className="mr-[4.6cqw] size-[1.4cqw] shrink-0 rounded-full bg-raised shadow-[2.2cqw_0_var(--raised),4.4cqw_0_var(--raised)]"
        />
        <img
          className="size-[3cqw]"
          src={`/app-icons/${scene.icon}.png`}
          alt=""
          width="16"
          height="16"
        />
        {scene.title}
      </div>
      <div
        className={`flex h-full flex-col gap-[2.2cqw] px-[3.8cqw] py-[3.4cqw] ${scene.kind === "term" ? "bg-preview" : ""}`}
      >
        {body}
      </div>
    </div>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

const VISIBLE = 5;
const CORNERS = [
  "top-0 left-0 border-t-2 border-l-2",
  "top-0 right-0 border-t-2 border-r-2",
  "bottom-0 left-0 border-b-2 border-l-2",
  "right-0 bottom-0 border-r-2 border-b-2",
];
/** The hero: windows change, a capture is taken, and the frame drops into the strip. */
function Recorder() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  // `shots` captures have been taken; the screen shows the window the next one will see.
  const [shots, setShots] = useState(VISIBLE),
    [flash, setFlash] = useState(false);
  useEffect(() => {
    if (reduced || !ref.current) return;
    let visible = false,
      timer = 0;
    // Runs only while the recorder is on screen and the tab is visible.
    const tick = (capture: boolean) => {
      timer = window.setTimeout(
        () => {
          if (!visible || document.hidden) return tick(capture);
          if (capture) {
            setFlash(true);
            setShots((n) => n + 1);
          } else setFlash(false);
          tick(!capture);
        },
        capture ? 1700 : 900,
      );
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(ref.current);
    tick(true);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [reduced]);
  // Right after a capture the screen still shows what was captured.
  const current = flash ? shots - 1 : shots;
  const shown = SCENES[current % SCENES.length];
  const tiles = [];
  for (let i = Math.max(0, shots - VISIBLE - 1); i < shots; i++) tiles.push(i);
  return (
    <figure className="@container m-0" ref={ref}>
      <div
        className="relative aspect-[16/10.5] overflow-hidden rounded-[14px] border border-frame bg-preview"
        aria-hidden="true"
      >
        <div className="flex h-[4.6cqw] items-center gap-[1.6cqw] bg-surface px-[2.6cqw] text-[2.2cqw] text-muted">
          <span className="mr-auto font-semibold text-ink">{shown.app}</span>
          <span
            className={`size-[1.4cqw] rounded-full bg-crumb ${flash ? "ring-[0.6cqw] ring-crumb/30" : "animate-breathe motion-reduce:animate-none"}`}
          />
          <span>{shotTime(current)}</span>
        </div>
        <div className="absolute inset-x-0 top-[4.6cqw] bottom-0 px-[6%] pt-[4%]">
          <Window key={current} scene={shown} seed={current} />
        </div>
        {flash && (
          <i
            key={shots}
            className="pointer-events-none absolute inset-0 animate-flash bg-[color-mix(in_srgb,var(--crumb-strong)_35%,#fff)] motion-reduce:hidden"
          />
        )}
        <div
          className={`pointer-events-none absolute inset-x-[3cqw] top-[7.5cqw] bottom-[3cqw] transition ease-out motion-reduce:transition-none ${flash ? "scale-100 opacity-100 duration-150" : "scale-105 opacity-0 duration-500"}`}
        >
          {CORNERS.map((corner) => (
            <i key={corner} className={`absolute size-[5cqw] border-crumb ${corner}`} />
          ))}
        </div>
      </div>
      <ol className="relative m-0 mt-4 h-[calc(11.5cqw+26px)] list-none p-0" aria-hidden="true">
        {tiles.map((i) => {
          const position = i - (shots - VISIBLE);
          const latest = i === shots - 1 && shots > VISIBLE;
          return (
            <li
              key={i}
              className={`absolute top-0 left-0 w-[18.4cqw] transition-[translate,opacity] duration-[650ms] ease-settle motion-reduce:transition-none ${position < 0 ? "opacity-0" : ""}`}
              style={{ translate: `calc(${position} * 20.4cqw) 0` }}
            >
              <div
                className={`@container relative aspect-[16/10] overflow-hidden rounded-md border bg-preview px-[6%] pt-[5%] transition-colors duration-1000 ${latest ? "animate-drop border-crumb motion-reduce:animate-none" : "border-frame"}`}
              >
                <Window scene={SCENES[i % SCENES.length]} seed={i} still />
              </div>
              <span
                className={`mt-[7px] block text-[11px] transition-colors duration-1000 ${latest ? "text-crumb" : "text-subtle"}`}
              >
                {shotTime(i)}
              </span>
            </li>
          );
        })}
      </ol>
      <figcaption className="mt-1 text-xs text-muted">
        An example morning. Each frame is one capture: a screenshot, plus the app, the window title,
        and the text on screen.
      </figcaption>
    </figure>
  );
}

/** One capture, opened up: everything Breadcrumb keeps for it. */
function CaptureCard() {
  const scene = SCENES[0];
  const rows: [string, ReactNode][] = [
    ["Time", `Tuesday, ${shotTime(0)}:04`],
    ["App", scene.app],
    ["Window", scene.title],
    ["Text on screen", <code className="font-mono text-xs">{scene.text}</code>],
  ];
  return (
    <div>
      <div className={PANEL}>
        <Window scene={scene} still />
      </div>
      <dl className="m-0 mt-4">
        {rows.map(([term, value]) => (
          <div
            key={term}
            className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-line py-[9px] md:grid-cols-[110px_minmax(0,1fr)]"
          >
            <dt className="text-xs text-muted">{term}</dt>
            <dd className="m-0 text-[13px] wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type Span = { from: number; to: number; scene?: number; skipped?: string };
const DAY: Span[] = [
  { from: 540, to: 590, scene: 0 },
  { from: 590, to: 625, scene: 1 },
  { from: 625, to: 660, scene: 2 },
  { from: 660, to: 690, scene: 3 },
  { from: 690, to: 735, scene: 4 },
  { from: 735, to: 755, scene: 5 },
  { from: 755, to: 810, skipped: "Away from the computer" },
  { from: 810, to: 860, scene: 0 },
  { from: 860, to: 880, skipped: "Password manager excluded" },
  { from: 880, to: 935, scene: 2 },
  { from: 935, to: 990, scene: 4 },
  { from: 990, to: 1020, scene: 3 },
];
const pct = (m: number) => `${((m - START) / (END - START)) * 100}%`;

function DayTrack() {
  return (
    <div className="relative h-7">
      {DAY.map((span) => (
        <i
          key={span.from}
          className={`absolute inset-y-0 rounded-md ${span.skipped ? HATCH : "bg-crumb/80"}`}
          style={{ left: pct(span.from), width: `calc(${pct(span.to)} - ${pct(span.from)} - 2px)` }}
        />
      ))}
    </div>
  );
}

/** The gaps: time away and excluded apps leave nothing behind. */
function PauseTrack() {
  return (
    <div>
      <DayTrack />
      <div className="mt-2 flex justify-between text-[11px] text-subtle" aria-hidden="true">
        <span>9 AM</span>
        <span>1 PM</span>
        <span>5 PM</span>
      </div>
      <ul className="m-0 mt-5 grid list-none gap-2 p-0">
        {DAY.filter((s) => s.skipped).map((s) => (
          <li key={s.from} className="flex items-center gap-2.5 text-[13px] text-secondary">
            <i className={`h-3 w-[22px] shrink-0 rounded ${HATCH}`} />
            {clock(s.from)} to {clock(s.to)}: {s.skipped!.toLowerCase()}, nothing saved
          </li>
        ))}
      </ul>
    </div>
  );
}

const THUMB = [
  "[&::-webkit-slider-thumb]:h-10 [&::-webkit-slider-thumb]:w-1.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-[3px] [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_var(--surface)]",
  "[&::-moz-range-thumb]:h-10 [&::-moz-range-thumb]:w-1.5 [&::-moz-range-thumb]:rounded-[3px] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:shadow-[0_0_0_3px_var(--surface)]",
].join(" ");
/** Drag through an example day, the way History works in the app. */
function Scrubber() {
  const [m, setM] = useState(640);
  const span = DAY.find((s) => m >= s.from && m < s.to) ?? DAY[DAY.length - 1];
  const scene = span.scene === undefined ? undefined : SCENES[span.scene];
  return (
    <div>
      <div className={`${PANEL} ${scene ? "" : "grid place-items-center p-0"}`}>
        {scene ? (
          <Window key={span.from} scene={scene} seed={span.from} />
        ) : (
          <p className="m-0 text-[13px] text-muted">{span.skipped}. Nothing was saved.</p>
        )}
      </div>
      <div className="mt-4 mb-2.5 flex items-baseline justify-between gap-3" aria-hidden="true">
        <strong className="text-xl font-semibold">{clock(m)}</strong>
        <span className="text-[13px] text-muted">
          {scene ? `${scene.activity} in ${scene.app}` : "No captures"}
        </span>
      </div>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-1.5">
          <DayTrack />
        </div>
        <input
          type="range"
          min={START}
          max={END - 5}
          step={5}
          value={m}
          aria-label="Time of day"
          aria-valuetext={
            scene ? `${clock(m)}, ${scene.app}: ${scene.title}` : `${clock(m)}, ${span.skipped}`
          }
          onChange={(e) => setM(+e.target.value)}
          className={`absolute inset-0 m-0 h-10 w-full cursor-ew-resize appearance-none rounded-none border-0 bg-transparent p-0 ${THUMB}`}
        />
      </div>
    </div>
  );
}

const STEPS = [
  {
    title: "It takes a screenshot",
    body: "Once a minute, and whenever you switch windows, Breadcrumb captures the screen you’re working on. It notes the app and window title, and reads the text on screen to tell your projects apart.",
    visual: <CaptureCard />,
  },
  {
    title: "It stops when you do",
    body: "After five minutes without keyboard or mouse input, capture pauses, so a screen left on over lunch doesn’t count. Apps you exclude are never captured. Breadcrumb never records audio or keystrokes.",
    visual: <PauseTrack />,
  },
  {
    title: "You look back",
    body: "Drag through your day like a video. Breadcrumb groups captures by app and project and adds up the time, so you can find what you saw and see where the hours went. Try it here.",
    visual: <Scrubber />,
  },
];

const BUTTON =
  "inline-block rounded-full bg-accent px-4 py-[9px] text-[13px] font-semibold text-accent-ink transition-colors hover:bg-accent-hover";
const H2 = "m-0 mb-3.5 text-[28px] leading-[1.1] font-semibold tracking-[-0.02em] md:text-[32px]";
const PROSE = "m-0 max-w-[34em] text-[15px] leading-[1.65] text-secondary";
const SECTION = "border-t border-line py-14 md:py-[72px]";
const SPLIT = "grid items-start gap-x-14 gap-y-8 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]";

export function Home({ signIn }: { signIn: ReactNode }) {
  return (
    <div className="flex-1">
      <section className="grid items-center gap-x-14 gap-y-10 pt-12 pb-16 min-[860px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[860px]:pt-20 min-[860px]:pb-[88px]">
        <div>
          <h1 className="m-0 mb-5 text-[46px] leading-[0.98] font-[650] tracking-[-0.04em] min-[860px]:text-[64px]">
            Rewind your day.
          </h1>
          <p className="m-0 max-w-[30em] text-[17px] leading-[1.6] text-secondary">
            Breadcrumb sits in your menu bar and quietly takes a screenshot of what you’re working
            on. Scroll back through it any time to find something you saw, or to see where the hours
            went.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <a className={BUTTON} href="/download">
              Download Breadcrumb
            </a>
            <a className="text-[13px] font-semibold text-secondary hover:text-ink" href="#how">
              How it works
            </a>
          </div>
          <p className="m-0 mt-3.5 text-xs text-subtle">
            Free and open source. Works offline, with no account.
          </p>
        </div>
        <Recorder />
      </section>

      <section className={SECTION} id="how" aria-labelledby="how-title">
        <h2 id="how-title" className={H2}>
          How it works
        </h2>
        <ol className="m-0 mt-10 grid list-none gap-14 p-0 md:gap-[72px]">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="grid items-center gap-x-14 gap-y-7 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]"
            >
              <div>
                <span
                  aria-hidden="true"
                  className="grid size-[30px] place-items-center rounded-full border border-frame text-[13px] font-semibold text-secondary"
                >
                  {i + 1}
                </span>
                <h3 className="m-0 mt-[18px] mb-2.5 text-2xl font-semibold tracking-[-0.015em]">
                  {step.title}
                </h3>
                <p className={PROSE}>{step.body}</p>
              </div>
              <div className="rounded-2xl border border-line bg-surface p-4 md:p-[22px]">
                {step.visual}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${SECTION} ${SPLIT}`} aria-labelledby="local-title">
        <div>
          <h2 id="local-title" className={H2}>
            Your history stays on your computer
          </h2>
          <p className={PROSE}>
            Recording needs no account and no internet. Captures are saved as plain files in a
            folder you can open, and you decide how long to keep them and how much disk they use.
          </p>
          <ul className="m-0 mt-6 grid list-none gap-2.5 p-0 text-sm">
            {[
              "Screenshots are JPEGs. Details are JSON.",
              "Nearly identical screens share one image, so a quiet hour takes little space.",
              "Pause from the menu bar or system tray whenever you like.",
            ].map((item) => (
              <li
                key={item}
                className="relative pl-[18px] before:absolute before:top-[0.55em] before:left-0 before:size-[7px] before:rounded-full before:bg-subtle before:content-['']"
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
        <figure
          className="m-0 rounded-[14px] border border-line bg-surface px-[22px] py-5 font-mono text-[13px]"
          aria-label="Example of the Breadcrumb folder"
        >
          <p className="m-0 mb-2 font-semibold">Breadcrumb</p>
          <ul className="m-0 list-none border-l border-frame p-0 pl-4 text-secondary">
            {["library.json", "2f6c41e0.json", "9a03b7d2.json"].map((file) => (
              <li key={file} className="py-[3px] pl-2.5">
                {file}
              </li>
            ))}
            <li className="py-[3px] pl-2.5">
              images
              <ul className="m-0 mt-1 list-none border-l border-frame p-0 pl-4">
                {["3fa9c1e8.jpg", "b27d0a54.jpg"].map((file) => (
                  <li key={file} className="py-[3px] pl-2.5">
                    {file}
                  </li>
                ))}
              </ul>
            </li>
          </ul>
        </figure>
      </section>

      <section className={`${SECTION} ${SPLIT} pb-[88px]`} aria-labelledby="get-title">
        <div>
          <h2 id="get-title" className={H2}>
            Get Breadcrumb
          </h2>
          <p className={PROSE}>
            For macOS 14 or later on Apple Silicon and Intel, and Windows on x64. On Linux, build it
            from source.
          </p>
          <a className={`${BUTTON} mt-[22px]`} href="/download">
            Download Breadcrumb
          </a>
          <p className="m-0 mt-3.5 text-xs text-subtle">
            <a
              className="underline underline-offset-3 hover:text-ink"
              href="https://github.com/hackclub/breadcrumb"
              target="_blank"
              rel="noreferrer"
            >
              Source and Linux build steps on GitHub
            </a>
          </p>
        </div>
        {signIn}
      </section>
    </div>
  );
}
