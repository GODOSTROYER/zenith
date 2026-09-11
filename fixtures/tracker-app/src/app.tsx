/**
 * The screen. One list of equipment requests, one form to add to it, one
 * drawer to read and change a single request, and a footer that says which
 * release of this app is actually running.
 *
 * Everything that can go wrong is a visible state rather than a silent
 * failure: loading, denied, signed out, unavailable, or a refusal this version
 * does not recognise.
 */
import { useState } from "react";
import type { EquipmentRequest } from "./api";
import { RoleBadge } from "./components/badges";
import { FilterBar } from "./components/filters";
import { NewRequestForm } from "./components/new-request-form";
import { Notice } from "./components/notice";
import { RequestDrawer } from "./components/request-drawer";
import { RequestList } from "./components/request-list";
import { SaveStateNotice } from "./components/save-state-notice";
import { useTracker } from "./use-tracker";

export default function App() {
  const tracker = useTracker();
  const [composing, setComposing] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  const {
    load,
    session,
    canWrite,
    items,
    filters,
    selected,
    createState,
    saveState,
  } = tracker;

  const openRecord = (record: EquipmentRequest, from: HTMLButtonElement) => {
    setTrigger(from);
    tracker.open(record);
  };

  const filtered = Boolean(filters.status || filters.category);
  const summary =
    load.kind === "loading"
      ? "Loading\u2026"
      : `${items.length} shown${tracker.hasMore ? ", more available" : ""}`;

  return (
    <div className="shell">
      <a className="skip" href="#requests">
        Skip to the requests
      </a>

      <header className="topbar">
        <div className="topbar-main">
          <h1 className="app-name">{session?.app.name ?? "Equipment requests"}</h1>
          <p className="app-sub">What the team has asked for, and where each request got to.</p>
        </div>
        <div className="topbar-side">
          {session && load.kind !== "signed_out" ? (
            <>
              <span className="who">{session.email}</span>
              <RoleBadge role={session.role} />
              <button type="button" className="button quiet" onClick={tracker.leave}>
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      <main className="main">
        {load.kind === "loading" ? (
          <p className="empty" role="status">
            {"Loading requests\u2026"}
          </p>
        ) : null}

        {load.kind === "ready" ? null : (
          <SaveStateNotice
            state={load}
            what="request"
            mode="read"
            onRetry={load.kind === "loading" ? undefined : tracker.retry}
          />
        )}

        {load.kind === "ready" ? (
          <>
            <div className="toolbar">
              <FilterBar filters={filters} onChange={tracker.setFilters} summary={summary} />
              {canWrite ? (
                <button
                  type="button"
                  className="button primary"
                  aria-expanded={composing}
                  aria-controls="new-request"
                  onClick={() => {
                    tracker.resetCreate();
                    setComposing((open) => !open);
                  }}
                >
                  {composing ? "Close the form" : "New request"}
                </button>
              ) : (
                <p className="hint">
                  Your access is view-only. Adding a request is not part of it.
                </p>
              )}
            </div>

            {composing && canWrite ? (
              <div id="new-request">
                <NewRequestForm
                  state={createState}
                  onCreate={tracker.create}
                  onDirty={tracker.resetCreate}
                  onCancel={() => {
                    tracker.resetCreate();
                    setComposing(false);
                  }}
                />
              </div>
            ) : null}

            <section className="list-section" id="requests" aria-labelledby="list-heading">
              <h2 className="section-title" id="list-heading">
                Requests
              </h2>
              <RequestList
                items={items}
                selectedId={selected?.id ?? null}
                filtered={filtered}
                onOpen={openRecord}
              />
              {tracker.moreError ? (
                <Notice tone="warn" title="That page did not load" live>
                  <p>{tracker.moreError}</p>
                </Notice>
              ) : null}
              {tracker.hasMore ? (
                <button
                  type="button"
                  className="button"
                  onClick={tracker.loadMore}
                  disabled={tracker.loadingMore}
                >
                  {tracker.loadingMore ? "Loading\u2026" : "Load more"}
                </button>
              ) : null}
            </section>
          </>
        ) : null}
      </main>

      <footer className="footer">
        <span>
          {session ? `release ${session.releaseId}` : "release unknown"}
          {session ? ` \u00b7 schema v${session.schemaVersion}` : ""}
        </span>
        <span>Requests are kept by the host. This app stores nothing in your browser.</span>
      </footer>

      {selected ? (
        <RequestDrawer
          key={selected.id}
          record={selected}
          canWrite={canWrite}
          state={saveState}
          onSave={tracker.save}
          onResolveConflict={tracker.resolveConflict}
          onDiscardConflict={tracker.discardConflict}
          onClose={tracker.close}
          onDirty={tracker.resetSave}
          returnFocusTo={trigger}
        />
      ) : null}
    </div>
  );
}
