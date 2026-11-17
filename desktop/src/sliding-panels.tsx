import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const order = ["overview", "history", "sessions", "saved", "activity", "settings"];

export function SlidingPanels({ view, children }: { view: string; children: ReactNode }) {
  const latest = useRef(children);
  const [panels, setPanels] = useState<{
    view: string;
    direction: number;
    previous: { view: string; content: ReactNode } | null;
  }>({ view, direction: 1, previous: null });
  if (panels.view !== view) {
    setPanels({
      view,
      direction: order.indexOf(view) >= order.indexOf(panels.view) ? 1 : -1,
      previous: { view: panels.view, content: latest.current },
    });
  }
  useLayoutEffect(() => {
    latest.current = children;
  });
  useEffect(() => {
    if (!panels.previous) return;
    const timer = setTimeout(() => setPanels((current) => ({ ...current, previous: null })), 220);
    return () => clearTimeout(timer);
  }, [panels.view, panels.previous]);
  const frames = [
    ...(panels.previous ? [{ ...panels.previous, active: false }] : []),
    { view, content: children, active: true },
  ];
  return (
    <div
      className="panel-viewport"
      style={{ "--slide-direction": panels.direction } as CSSProperties}
    >
      {frames.map((frame) => (
        <div
          key={frame.view}
          className={`panel-page ${panels.previous ? (frame.active ? "panel-enter" : "panel-exit") : ""}`}
          data-active={frame.active}
          aria-hidden={frame.active ? undefined : true}
          inert={!frame.active}
        >
          {frame.content}
        </div>
      ))}
    </div>
  );
}
