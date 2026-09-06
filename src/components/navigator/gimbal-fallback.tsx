import type { GimbalState } from "./gimbal-contract";

/** Lightweight first paint and no-WebGL fallback, matching the living gyroscope. */
export function GimbalFallback({ state, hidden = false }: { state: GimbalState | null; hidden?: boolean }) {
  const focused = state === "planning" || state === "applying" || state === "blocked";
  const angles = state === "awaiting_approval" ? [18, 24, 30]
    : state === "applying" ? [32, 32, 32]
    : state === "blocked" ? [12, 78, -30] : [32, -48, 14];
  return (
    <svg className="gimbal-static" viewBox="0 0 256 256" aria-hidden="true" style={hidden ? { display: "none" } : undefined}>
      <g fill="none" stroke="#8999b2" strokeWidth="2">
        <ellipse cx="128" cy="128" rx="108" ry="84" transform={`rotate(${angles[0]} 128 128)`} />
        <ellipse cx="128" cy="128" rx="88" ry="54" transform={`rotate(${angles[1]} 128 128)`} />
        <ellipse cx="128" cy="128" rx="67" ry="53" transform={`rotate(${angles[2]} 128 128)`} />
      </g>
      <path d="M 213 63 A 108 84 32 0 1 230 91" fill="none" stroke="var(--gimbal-accent, #b89cff)" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="128" cy="128" rx="42" ry="35" fill="#364154" />
      <ellipse cx="128" cy="127" rx="37" ry="28" fill="#080e19" />
      <g fill="#ffd69c">
        <rect x="110" y={focused ? 121 : 118} width="8" height={focused ? 10 : 15} rx="4" />
        <rect x="138" y={focused ? 121 : 118} width="8" height={focused ? 10 : 15} rx="4" />
      </g>
      <path d={state === "blocked" ? "M121 140 Q128 138 135 140" : state === "verified" ? "M121 138 Q128 145 135 138" : "M121 140 Q128 142 135 140"} fill="none" stroke="#ffd69c" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
