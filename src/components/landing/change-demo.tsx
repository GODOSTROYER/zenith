"use client";

import { DEMO_COST, DEMO_STEPS, revisionLabel, type DemoSelection } from "./demo-fixture";
import { RevisionScene } from "./revision-scene";
import type { RevisionDemo } from "./use-revision-demo";
import { fmtUsd } from "@/lib/format";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import styles from "./change-demo.module.css";

export function ChangeDemo({ demo }: { demo: RevisionDemo }) {
  const hasQueue = demo.manifest.resources.length > 0;
  const selected = hasQueue ? demo.selected : demo.selected === "atlas-jobs" ? "atlas-api" : demo.selected;
  const selectedBindings = demo.manifest.bindings.filter((binding) => binding.from === selected || binding.to === selected);
  const restored = demo.stage === "restored";
  const recorded = demo.stage === "recorded";
  const railHeading = demo.isHistorical ? `Viewing historical revision ${revisionLabel(demo.revision)}` : restored ? `Restored revision ${revisionLabel(demo.currentRevision)}` : recorded ? `Recorded revision ${revisionLabel(demo.currentRevision)}` : demo.isRunning ? `Simulating revision ${revisionLabel(demo.proposedRevision)}` : `Proposed revision ${revisionLabel(demo.proposedRevision)}`;
  return (
    <section id="change-demo" className={styles.section} aria-labelledby="change-demo-heading">
      <div className={styles.intro}>
        <h2 id="change-demo-heading">The difference<br />is the point.</h2>
        <p>Review the queue and both bindings before the change runs. The next revision starts with your decision.</p>
      </div>
      <div className={styles.workspace}>
        <div className={styles.toolbar}>
          <span className={styles.project}>Interactive simulation <span>/ atlas · Sandbox</span></span>
          <span className={styles.synthetic}>Synthetic data · no cloud connection</span>
        </div>
        <div className={styles.columns}>
          <div className={styles.mapPanel}>
            <div className={styles.mapHeader}>
              <div className={styles.switch} aria-label="Inspect a demo revision">
                <button type="button" aria-pressed={!demo.isHistorical && demo.inspected === "current"} disabled={demo.isRunning} onClick={() => demo.inspect("current")}>Current {revisionLabel(demo.currentRevision)}</button>
                {!recorded && <button type="button" aria-pressed={!demo.isHistorical && demo.inspected === "proposed"} disabled={demo.isRunning} onClick={() => demo.inspect("proposed")}>Proposed {revisionLabel(demo.proposedRevision)}</button>}
              </div>
              <span className={styles.revision}>REV {revisionLabel(demo.revision)}</span>
            </div>
            <p className={styles.historyNotice}>{demo.isHistorical ? `Historical revision ${revisionLabel(demo.revision)} · active ${revisionLabel(demo.currentRevision)} unchanged.` : "Inspect a resource to read its bindings."}</p>
            <RevisionScene phase={demo.phase} selected={selected} tone="dark" className={styles.scene} />
            <div className={styles.resourceControls} aria-label="Inspect resources">
              {(["atlas-api", "atlas-worker", ...(hasQueue ? ["atlas-jobs"] : [])] as DemoSelection[]).map((resource) => <button key={resource} type="button" aria-pressed={selected === resource} onClick={() => demo.select(resource)}>{resource}{resource === "atlas-jobs" && demo.stage === "review" && !demo.isHistorical ? " +" : ""}</button>)}
            </div>
            <div className={styles.inspector}>
              <span className={styles.eyebrow}>Selected resource</span>
              <h3>{selected}</h3>
              <p>{selected === "atlas-jobs" ? "Standard queue · SQS-shaped · nano estimate tier. Buffers background work between the API and worker." : selected === "atlas-api" ? "Web service · small · one replica. Publishes jobs when the queue binding is present." : "Worker service · small · one replica. Consumes jobs when the queue binding is present."}</p>
              {selectedBindings.length ? <ul>{selectedBindings.map((binding) => <li key={binding.id}><code>{binding.from} → {binding.to}</code><span>{binding.capability}</span></li>)}</ul> : <p className={styles.muted}>No queue bindings in this revision.</p>}
            </div>
          </div>
          <div className={styles.planPanel} role="region" aria-label="Revision details">
            <h3>{railHeading}</h3>
            {demo.isHistorical ? <>
              <p className={styles.note}>Read-only configuration from the demo audit trail. Active revision {revisionLabel(demo.currentRevision)} and your approval state are unchanged.</p>
              <dl className={styles.changeList}><div><dt>Services</dt><dd>2</dd></div><div><dt>Queues</dt><dd>{hasQueue ? "1" : "0"}{hasQueue && <span>atlas-jobs</span>}</dd></div><div><dt>Bindings</dt><dd>{demo.manifest.bindings.length}</dd></div></dl>
              <dl className={styles.estimate}><dt>Estimated monthly cost of this configuration</dt><dd>{fmtUsd(hasQueue ? DEMO_COST.proposed : DEMO_COST.current)}</dd></dl>
              <p className={styles.note}>Static estimate: two small services, one replica each{hasQueue ? "; one nano queue" : ""}. Synthetic configuration, not a billing quote.</p>
              {demo.stage === "review" && <button type="button" className={styles.secondary} onClick={() => demo.inspect("proposed")}>Return to proposal {revisionLabel(demo.proposedRevision)} <ArrowUpRight size={18} aria-hidden="true" /></button>}
            </> : <>
              {(recorded || restored) && <p className={styles.note}>{restored ? "Restored the revision 08 configuration as a new simulated revision. The queue and its two bindings were removed from this configuration." : "The simulation added atlas-jobs and both bindings. This configuration is now the active demo revision."}</p>}
              <dl className={styles.changeList}>
                <div><dt>{recorded ? "Added" : "Additions"}</dt><dd>{restored ? "0" : "1"}{!restored && <span>atlas-jobs</span>}</dd></div>
                <div><dt>{restored ? "Removed bindings" : recorded ? "Bindings added" : "New bindings"}</dt><dd>2 <span>publish / consume</span></dd></div>
                <div><dt>{restored ? "Removed resources" : "Removals"}</dt><dd>{restored ? "1" : "0"}{restored && <span>atlas-jobs</span>}</dd></div>
              </dl>
              <dl className={styles.estimate}><dt>Estimated monthly cost</dt><dd>{fmtUsd(restored ? DEMO_COST.proposed : DEMO_COST.current)} → {fmtUsd(restored ? DEMO_COST.current : DEMO_COST.proposed)}</dd><dd className={styles.delta}>{fmtUsd(restored ? -DEMO_COST.delta : DEMO_COST.delta, { sign: true })} per month</dd></dl>
              <p className={styles.note}>Static estimate: two small services, one replica each; {restored ? "nano queue removed" : "one nano queue"}. Synthetic configuration, not a billing quote.</p>
              {!restored && <div className={styles.risk}><span>{recorded ? "Application responsibility" : "Review before proceeding"}</span><p>The binding makes a queue available to the worker. Your application still needs to publish and consume jobs correctly, including retries and duplicate handling.</p></div>}
            </>}
            {demo.stage === "review" && !demo.isHistorical && <div className={styles.approval}>
              <span className={styles.eyebrow}>Your approval boundary</span>
              <p>Nothing runs until you review this plan and choose Run simulation.</p>
              <label><input type="checkbox" checked={demo.reviewed} onChange={(event) => demo.setReviewed(event.target.checked)} />I have reviewed the plan and estimate.</label>
              <button className={styles.primary} type="button" disabled={!demo.reviewed} title={!demo.reviewed ? "Review the plan and select the checkbox first." : undefined} onClick={demo.run}>Run simulation <ArrowUpRight size={18} aria-hidden="true" /></button>
            </div>}
            {demo.isRunning && <div className={styles.progress} role="status" aria-live="polite">
              <h4>Running simulation · {demo.step + 1} / 3</h4>
              <ol>{DEMO_STEPS.map((step, index) => <li key={step} data-current={index === demo.step} data-done={index < demo.step}><span>{String(index + 1).padStart(2, "0")}</span>{step}<em>{index < demo.step ? "Recorded" : index === demo.step ? "In progress" : "Waiting"}</em></li>)}</ol>
            </div>}
            {demo.stage === "recorded" && <div className={styles.result} role="status" aria-live="polite">
              <span className={styles.eyebrow}>Simulation complete</span>
              <h4>Active revision {revisionLabel(demo.currentRevision)} recorded.</h4>
              <p>Queue and binding outputs are simulated. No provider was contacted.</p>
              <code>sim://atlas/revisions/{revisionLabel(demo.currentRevision)}/atlas-jobs</code>
              <button type="button" className={styles.secondary} onClick={demo.restore}>Restore previous demo revision <RotateCcw size={18} aria-hidden="true" /></button>
              <p className={styles.note}>Creates a new revision with the 08 configuration. In the product, rollback redeploys prior configuration; it does not recover deleted data.</p>
            </div>}
            {demo.stage === "restored" && <div className={styles.result} role="status" aria-live="polite">
              <span className={styles.eyebrow}>Previous configuration restored · simulated</span>
              <h4>Active revision {revisionLabel(demo.currentRevision)} keeps the history.</h4>
              <p>Atlas is back to two services. Revision 09 remains in the demo audit trail. This restores configuration, not deleted data.</p>
              <button type="button" className={styles.secondary} onClick={() => demo.inspect("proposed")}>Review the queue again <ArrowUpRight size={18} aria-hidden="true" /></button>
            </div>}
          </div>
        </div>
        <div className={styles.audit}>
          <span className={styles.eyebrow}>Demo audit trail</span>
          <ol>{demo.history.map((record) => <li key={record.revision}><button type="button" className={styles.historyButton} aria-pressed={demo.viewedRevision === record.revision} disabled={demo.isRunning} title={demo.isRunning ? "Wait for the simulation to finish before inspecting history." : "View this recorded configuration without changing the active revision."} onClick={() => demo.viewHistory(record.revision)}>View revision {revisionLabel(record.revision)}</button><span className={styles.recordDescription}>{record.description}</span></li>)}</ol>
          <button type="button" disabled={demo.isRunning} title={demo.isRunning ? "Wait for the simulation to finish." : "Clears only this page’s demonstration."} onClick={demo.reset}>Reset demonstration</button>
        </div>
      </div>
    </section>
  );
}
