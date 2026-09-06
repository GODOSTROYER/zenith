"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Changeset, Manifest } from "@/lib/domain/types";
import { buildRehearsalModel, type RehearsalModel } from "./rehearsal-model";
import type { RehearsalRenderer, RehearsalState } from "./rehearsal-renderer";
import styles from "./change-rehearsal.module.css";

export interface ChangeRehearsalProps {
  currentManifest: Manifest | null;
  proposedManifest: Manifest;
  changeset: Changeset;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  environmentName: string;
  className?: string;
}

function TopologyFallback({ model, view }: { model: RehearsalModel; view: "current" | "proposed" }) {
  const position = (id: string) => {
    const node = model.nodes.find((value) => value.id === id);
    return node && node[view] ? { x: 240 + node.x * 52, y: 103 + node.z * 46 } : null;
  };
  return <svg viewBox="0 0 480 240" aria-hidden="true">
    {model.bindings.map((binding) => {
      const value = binding[view];
      if (!value) return null;
      const from = position(value.from), to = position(value.to);
      if (!from || !to) return null;
      const selected = binding.id === model.selectedId || model.selectedNodes.includes(value.from) || model.selectedNodes.includes(value.to);
      return <path key={binding.id} d={`M ${from.x} ${from.y} V ${(from.y + to.y) / 2} H ${to.x} V ${to.y}`} fill="none" stroke={selected ? "var(--signal)" : "var(--ink-faint)"} strokeWidth={selected ? 2 : 1} />;
    })}
    {model.nodes.map((node) => {
      const pos = position(node.id);
      if (!pos) return null;
      const selected = model.selectedNodes.includes(node.id);
      return <g key={node.id} transform={`translate(${pos.x},${pos.y})`}>
        <rect x="-32" y="-21" width="64" height="42" rx="3" fill="var(--bg2)" stroke={selected ? "var(--signal)" : "var(--line)"} strokeWidth={selected ? 2 : 1} />
        <path d="M-23 -11H4 M-23 -6H-6" stroke="var(--ink-faint)" strokeWidth="1" />
        <text x="0" y="12" textAnchor="middle" fill="var(--ink)" fontSize="11" fontFamily="var(--font-mono)">{String(model.allNodes.findIndex((value) => value.id === node.id) + 1).padStart(2, "0")}</text>
      </g>;
    })}
  </svg>;
}

function RehearsalScene({ model, view }: { model: RehearsalModel; view: "current" | "proposed" }) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<RehearsalRenderer | null>(null);
  const latest = useRef({ model, view }); latest.current = { model, view };
  const sync = useRef(() => {});
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false, starting = false, failed = false, visible = false;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const lowPower = (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4 || !!nav.connection?.saveData;
    const settings = (): RehearsalState => ({ ...latest.current, light: document.documentElement.dataset.theme === "light", reducedMotion: preference.matches || lowPower });
    const fail = () => { failed = true; if (!disposed) setReady(false); renderer.current?.dispose(); renderer.current = null; };
    const update = () => {
      const active = visible && document.visibilityState !== "hidden";
      renderer.current?.setVisible(active);
      if (!active || starting || failed || disposed || renderer.current) return;
      starting = true;
      void import("./rehearsal-renderer").then(({ createRehearsalRenderer }) => {
        if (disposed || !visible || document.visibilityState === "hidden") return;
        const instance = createRehearsalRenderer(element, { ...settings(), lowPower, onError: fail });
        if (disposed || failed) { instance.dispose(); return; }
        renderer.current = instance;
        instance.setVisible(true);
        setReady(true);
      }).catch(fail).finally(() => { starting = false; });
    };
    sync.current = () => renderer.current?.setState(settings());
    const bounds = element.getBoundingClientRect();
    visible = bounds.width > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer?.observe(element);
    const theme = new MutationObserver(() => sync.current());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const preferencesChanged = () => sync.current();
    preference.addEventListener("change", preferencesChanged);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      disposed = true; observer?.disconnect(); theme.disconnect();
      preference.removeEventListener("change", preferencesChanged);
      document.removeEventListener("visibilitychange", update);
      renderer.current?.dispose(); renderer.current = null; sync.current = () => {};
    };
  }, []);
  useEffect(() => { sync.current(); }, [model, view]);
  return <div className={styles.scene} data-ready={ready}>
    <div className={styles.fallback}><TopologyFallback model={model} view={view} /></div>
    <div className={styles.canvas} ref={host} aria-hidden="true" />
    <div className={styles.caption}>{model.omitted > 0 ? `${model.nodes.length} of ${model.allNodes.length} resources shown · all resources listed` : "Configuration model · not live health"}</div>
  </div>;
}

const operation = { create: "Addition", update: "Modification", delete: "Removal" };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** Read-only rehearsal of the existing changeset. Approval remains with its caller. */
export function ChangeRehearsal({ currentManifest, proposedManifest, changeset, selectedId, onSelect, environmentName, className }: ChangeRehearsalProps) {
  const titleId = useId();
  const [view, setView] = useState<"current" | "proposed">("proposed");
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const activeId = selectedId !== undefined ? selectedId : localSelection ?? changeset.items[0]?.nodeId ?? null;
  const model = useMemo(() => buildRehearsalModel(currentManifest, proposedManifest, changeset, activeId), [currentManifest, proposedManifest, changeset, activeId]);
  const cost = view === "proposed" ? changeset.projectedMonthlyUsd : changeset.projectedMonthlyUsd - changeset.totalCostDeltaUsd;
  const selectedBinding = model.bindings.find((binding) => binding.id === activeId);
  const binding = selectedBinding?.[view];
  const nodeName = (id: string) => model.allNodes.find((node) => node.id === id)?.name ?? id;
  return <section className={[styles.rehearsal, className].filter(Boolean).join(" ")} aria-labelledby={titleId}>
    <div className={styles.header}>
      <div><h3 className={styles.title} id={titleId}>Change rehearsal</h3><div className={styles.context}>{environmentName} · {view === "current" ? "Deployed configuration" : "Proposed configuration"}</div></div>
      <div className={styles.switch} role="group" aria-label="Configuration comparison">
        <button type="button" aria-pressed={view === "current"} onClick={() => setView("current")}>Current</button>
        <button type="button" aria-pressed={view === "proposed"} onClick={() => setView("proposed")}>Proposed</button>
      </div>
    </div>
    {model.allNodes.length ? <div className={styles.body}>
      <RehearsalScene model={model} view={view} />
      <div className={styles.resources} role="group" aria-label="Resources in this comparison">
        {model.allNodes.map((node, index) => <button key={node.id} type="button" className={styles.resource} aria-pressed={model.selectedNodes.includes(node.id)} title={`${node.name} · ${node.id}`} onClick={() => { setLocalSelection(node.id); onSelect?.(node.id); }}>
          <span className={styles.index}>{String(index + 1).padStart(2, "0")}</span>
          <span><span className={styles.name}>{(view === "current" ? node.currentName : node.proposedName) ?? node.name}</span><span className={styles.status} data-change={!!node.change} style={{ display: "block" }}>{!node[view] ? `Absent from ${view}` : node.change ? operation[node.change] : node.affected ? "Binding affected" : "Unchanged"}</span></span>
        </button>)}
      </div>
    </div> : <div className={styles.empty}>No resources in this configuration yet.</div>}
    {selectedBinding && <div className={styles.connection}>
      <span className={styles.connectionLabel}>Selected binding</span>
      <span>{binding ? `${nodeName(binding.from)} → ${nodeName(binding.to)} · ${binding.capability.replaceAll("_", " ")}` : `Absent from ${view}`}</span>
      <code>{selectedBinding.id}</code>
    </div>}
    <div className={styles.footer}>
      <span>{view === "current" && !currentManifest ? "No deployed revision yet" : `${model.allNodes.filter((node) => node[view]).length} resources · ${model.bindings.filter((binding) => binding[view]).length} bindings`}</span>
      <span>Estimated monthly <span className={styles.cost}>{money.format(Math.max(0, cost))}</span></span>
    </div>
  </section>;
}
