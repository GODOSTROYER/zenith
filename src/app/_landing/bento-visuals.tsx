"use client";

import type { CSSProperties } from "react";
import { NODE_META, PROPOSED_BINDING_IDS, PROPOSED_IDS, systemFor, type ExampleNodeId } from "./scenario";
import type { SystemView } from "./landing-state";
import styles from "./bento-body.module.css";

export type GlyphName = "app" | "files" | "database" | "queue" | "worker" | "globe" | "arrow" | "check" | "lock" | "agent" | "person" | "document" | "layers";
const PATHS: Record<GlyphName, string[]> = {
  app: ["M4 4h16v16H4z", "M4 9h16", "M8 6.5h.01M11 6.5h.01", "m9 12-3 2.5L9 17m6-5 3 2.5-3 2.5"],
  files: ["M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z", "M3 9h18"],
  database: ["M20 6c0 2.2-16 2.2-16 0s16-2.2 16 0Z", "M4 6v12c0 2.2 16 2.2 16 0V6", "M4 12c0 2.2 16 2.2 16 0"],
  queue: ["M7 5h14M7 12h14M7 19h14", "M3 5h.01M3 12h.01M3 19h.01"],
  worker: ["m13 2-9 12h7l-1 8 10-13h-7l1-7Z"],
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M3 12h18", "M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"],
  arrow: ["M5 12h14m-5-5 5 5-5 5"],
  check: ["m5 12 4 4L19 6"],
  lock: ["M5 10h14v11H5z", "M8 10V6a4 4 0 0 1 8 0v4", "M12 14v3"],
  agent: ["M5 7h14v13H5z", "M12 3v4M2 11v5m20-5v5", "M9 12h.01M15 12h.01M9 16h6"],
  person: ["M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z", "M4 21v-2a8 8 0 0 1 16 0v2"],
  document: ["M5 3h9l5 5v13H5z", "M14 3v6h5M8 13h8M8 17h5"],
  layers: ["m12 3 10 5-10 5L2 8l10-5Z", "m2 12 10 5 10-5M2 16l10 5 10-5"],
};

/** A small, consistent icon vocabulary for real system objects, not decorative chrome. */
export function Glyph({ name, size = 20 }: { name: GlyphName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {PATHS[name].map((d) => <path key={d} d={d} />)}
  </svg>;
}

const POSITIONS: Record<ExampleNodeId, { x: number; y: number; glyph: GlyphName; label: string }> = {
  "public-route": { x: 70, y: 80, glyph: "globe", label: "Address" },
  "upload-api": { x: 250, y: 80, glyph: "app", label: "Your app" },
  "process-jobs": { x: 430, y: 80, glyph: "queue", label: "Job queue" },
  "process-worker": { x: 430, y: 240, glyph: "worker", label: "Worker" },
  uploads: { x: 70, y: 240, glyph: "files", label: "Files" },
  results: { x: 250, y: 240, glyph: "database", label: "Results" },
};
const CONNECTION_PATHS: Record<string, string> = {
  "route-api": "M124 80H196",
  "api-uploads": "M230 116C230 168 70 140 70 204",
  "api-results": "M250 116V204",
  "api-jobs": "M304 80H376",
  "worker-jobs": "M430 204V116",
  "worker-uploads": "M430 276C430 315 70 315 70 276",
  "worker-results": "M376 240H304",
};

/** Fixed positions let a proposal appear without moving the system that already exists. */
export function BentoSystemMap({ view, selected, highlighted, onSelect }: {
  view: SystemView;
  selected: ExampleNodeId;
  highlighted?: ExampleNodeId[];
  onSelect: (id: ExampleNodeId) => void;
}) {
  const manifest = systemFor(view);
  const ids = new Set([...manifest.services, ...manifest.resources, ...manifest.routes].map((part) => part.id));
  const active = ids.has(selected) ? selected : "upload-api";
  return <div className={styles.systemMap} data-micro-change="map" data-micro-value={`${view}:${active}`}>
    <svg className={styles.connections} viewBox="0 0 500 330" preserveAspectRatio="none" aria-hidden="true">
      {manifest.bindings.map((binding) => <path
        key={binding.id} d={CONNECTION_PATHS[binding.id]}
        data-proposed={PROPOSED_BINDING_IDS.includes(binding.id) || undefined}
        data-active={binding.from === active || binding.to === active || undefined}
      />)}
      {manifest.bindings.filter((binding) => binding.from === active || binding.to === active).map((binding) =>
        <path key={`trace-${binding.id}`} data-micro-beam pathLength="1" d={CONNECTION_PATHS[binding.id]} />
      )}
    </svg>
    {Object.entries(POSITIONS).filter(([id]) => ids.has(id)).map(([key, position]) => {
      const id = key as ExampleNodeId;
      const proposed = view === "proposed" && PROPOSED_IDS.includes(id);
      return <button key={id} type="button" className={styles.systemNode}
        style={{ "--x": `${position.x / 5}%`, "--y": `${position.y / 3.3}%` } as CSSProperties}
        aria-pressed={active === id} aria-label={`${position.label}${proposed ? ", proposed addition" : ""}`}
        data-guide={highlighted?.includes(id) || undefined} data-new={proposed || undefined} onClick={() => onSelect(id)} onFocus={() => onSelect(id)}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") onSelect(id); }}>
        <Glyph name={position.glyph} /><span>{position.label}</span>
        {proposed && <span className={styles.newPart} aria-hidden="true">+</span>}
      </button>;
    })}
    <span className="sr-only">{NODE_META[active].role} Lines show this part’s connections. Orange dashed outlines mark proposed additions.</span>
  </div>;
}
