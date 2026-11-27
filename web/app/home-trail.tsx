import type { CSSProperties } from "react";

// An illustrative day: the share of each hour spent at the computer.
const EXAMPLE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0.15, 0.7, 1, 0.9, 0.3, 0.55, 1, 0.95, 0.8, 0.4, 0.1, 0, 0.35, 0.85, 0.6,
  0.2,
];

/** The signed-out hero: one example day drawn the way the dashboard draws every hour. */
export function HomeTrail() {
  return (
    <figure className="home-trail">
      <div className="home-trail-crumbs" aria-hidden="true">
        {EXAMPLE.map((share, hour) => (
          <i
            key={hour}
            style={
              {
                "--t": share,
                "--mix": `${share ? 30 + 70 * share : 0}%`,
                "--i": hour,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="home-trail-hours" aria-hidden="true">
        <span>Midnight</span>
        <span>6 AM</span>
        <span>Noon</span>
        <span>6 PM</span>
      </div>
      <figcaption>
        An example day. Each crumb is an hour, and it grows with the time you spent at your
        computer.
      </figcaption>
    </figure>
  );
}
