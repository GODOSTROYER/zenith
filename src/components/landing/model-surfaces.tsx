"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { demoApi, demoSource, revisionLabel } from "./demo-fixture";
import { ArrowDown, ArrowUp, ArrowUpRight } from "lucide-react";
import type { RevisionDemo } from "./use-revision-demo";
import styles from "./model-surfaces.module.css";

const SURFACES = ["System Map", "Source", "API", "Navigator"] as const;
type Surface = typeof SURFACES[number];

export function ModelSurfaces({ demo }: { demo: RevisionDemo }) {
  const [surface, setSurface] = useState<Surface>("System Map");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const queue = demo.manifest.resources[0];
  const goToTab = (event: KeyboardEvent, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % 4 : event.key === "ArrowLeft" ? (index + 3) % 4 : event.key === "Home" ? 0 : event.key === "End" ? 3 : null;
    if (next === null) return;
    event.preventDefault();
    setSurface(SURFACES[next]);
    tabs.current[next]?.focus();
  };
  return (
    <section id="model-surfaces" className={styles.section} aria-labelledby="model-surfaces-heading">
      <div className={styles.intro}>
        <h2 id="model-surfaces-heading">One system.<br />Four ways in.</h2>
        <p>Move between the map, the source, the API and Navigator. Each surface reads the same Atlas revision you selected above.</p>
      </div>
      <div className={styles.workbench}>
        <div className={styles.tabs} role="tablist" aria-label="Ways to work with your system">
          {SURFACES.map((name, index) => <button key={name} ref={(element) => { tabs.current[index] = element; }} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={surface === name} tabIndex={surface === name ? 0 : -1} onClick={() => setSurface(name)} onKeyDown={(event) => goToTab(event, index)}><span className={styles.tabIndex}>{String(index + 1).padStart(2, "0")}</span>{name}</button>)}
        </div>
        <div className={styles.modelBar}>
          <span>atlas <span>/ REV {revisionLabel(demo.revision)} / {demo.isHistorical ? `historical · active ${revisionLabel(demo.currentRevision)}` : demo.stage === "review" && demo.inspected === "proposed" ? "proposal" : demo.stage === "applying" ? "simulating" : "current demo"}</span></span>
          <span className={styles.synthetic}>Synthetic fixture</span>
        </div>
        {SURFACES.map((name, index) => <div key={name} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} hidden={surface !== name} tabIndex={0} className={styles.panel}>
          {name === "System Map" && <div className={styles.mapContent}>
            <figure className={styles.diagram} aria-label={`Atlas revision ${revisionLabel(demo.revision)} binding diagram`}>
              <figcaption>Manifest relationships</figcaption>
              <div className={styles.diagramNode}><span>Web service</span><strong>atlas-api</strong></div>
              {queue ? <>
                <div className={styles.diagramBinding}><ArrowDown size={24} aria-hidden="true" /><code>queue_publish</code></div>
                <div className={`${styles.diagramNode} ${styles.queueNode}`}><span>Standard queue</span><strong>atlas-jobs</strong></div>
                <div className={styles.diagramBinding}><ArrowUp size={24} aria-hidden="true" /><code>queue_consume</code></div>
              </> : <p className={styles.noBindings}>No queue bindings in this revision</p>}
              <div className={styles.diagramNode}><span>Worker service</span><strong>atlas-worker</strong></div>
            </figure>
            <div className={styles.context}>
              <span className={styles.eyebrow}>Read the relationships</span>
              <h3>{queue ? "Work has somewhere to wait." : "Two services. A clear starting point."}</h3>
              <p>{queue ? "The API publishes to atlas-jobs. The worker consumes from it. Each line is an explicit capability in the manifest." : "atlas-api handles requests. atlas-worker handles background work. This revision has no queue or queue bindings."}</p>
              <dl><div><dt>Services</dt><dd>{demo.manifest.services.length}</dd></div><div><dt>Queues</dt><dd>{demo.manifest.resources.length}</dd></div><div><dt>Bindings</dt><dd>{demo.manifest.bindings.length}</dd></div></dl>
            </div>
          </div>}
          {name === "Source" && <div className={styles.codeContent}>
            <div className={styles.context}><span className={styles.eyebrow}>The canonical manifest</span><h3>The whole system,<br />in plain sight.</h3><p>Services, resources and bindings are declared together. The Source view edits this same structure through a typed action.</p><p className={styles.small}>Read-only demonstration. Image references use example.invalid; they are not deployable application images.</p></div>
            <pre className={styles.code} aria-label={`Synthetic source for Atlas revision ${revisionLabel(demo.revision)}`}><code>{demoSource(demo.manifest, demo.revision)}</code></pre>
          </div>}
          {name === "API" && <div className={styles.codeContent}>
            <div className={styles.context}><span className={styles.eyebrow}>The typed action API</span><h3>Build on the<br />same contract.</h3><p>This example plans an update to the same manifest. The product separates planning and execution with explicit action modes.</p><p className={styles.small}>Illustrative request using the existing endpoint schema. No request is sent; sim-atlas is a fixture identifier.</p></div>
            <pre className={styles.code} aria-label={`Synthetic API example for Atlas revision ${revisionLabel(demo.revision)}`}><code>{demoApi(demo.manifest, demo.revision)}</code></pre>
          </div>}
          {name === "Navigator" && <div className={styles.navigator}>
            <div className={styles.context}><span className={styles.eyebrow}>Intent, with boundaries</span><h3>Ask for a change.<br />Stay in charge.</h3><p>Navigator proposes typed actions against the same model. Autonomy settings and environment policies determine which actions require your approval.</p><p className={styles.small}>This conversation is scripted. The interactive simulation above always requires your explicit approval.</p></div>
            <div className={styles.conversation}>
              <div><span className={styles.speaker}>You / example request</span><p>Add a queue between the API and the worker.</p></div>
              <div><span className={styles.speaker}>Navigator / scripted illustration</span><p>{queue ? `Revision ${revisionLabel(demo.revision)} contains atlas-jobs and two bindings: atlas-api can publish; atlas-worker can consume.` : `Revision ${revisionLabel(demo.revision)} contains atlas-api and atlas-worker. Adding atlas-jobs would introduce one resource and two queue bindings.`}</p><p>Review the worker’s retry behavior before applying. A binding provides configuration; the application implements the job handling.</p></div>
              <div className={styles.boundary}><span>Approval boundary</span><p>{demo.isHistorical ? `This is a read-only view of revision ${revisionLabel(demo.revision)}. Active revision ${revisionLabel(demo.currentRevision)} and its simulation state are unchanged.` : demo.isRunning ? "You approved the plan. The local demonstration is now running." : demo.stage === "recorded" ? "Simulation complete. The audit record is retained below the plan." : demo.stage === "restored" ? "The previous configuration is restored as a new simulated revision." : "Review the plan above, then explicitly choose Run simulation."}</p></div>
            </div>
          </div>}
        </div>)}
        <div className={styles.footer}><span>Same manifest · same revision · four surfaces</span><a href="#change-demo">Inspect another revision <ArrowUpRight size={17} aria-hidden="true" /></a></div>
      </div>
    </section>
  );
}
