/**
 * The one hook that owns everything the screen reads: the session, the page of
 * requests, the filters, and the state of each write in flight.
 *
 * The rules it exists to keep:
 *   - a write is `saved` only after the host answered 2xx;
 *   - a write id survives a retry of the same bytes and is replaced the moment
 *     the bytes change, which is what re-basing after a conflict does;
 *   - a refusal becomes a state, never a thrown error the screen has to catch.
 *
 * Workstream W4 (hosted R3)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRequest,
  getSession,
  listRequests,
  newWriteId,
  signOut,
  TRACKER_LIMITS,
  updateRequest,
  type EquipmentRequest,
  type EquipmentRequestInput,
  type RequestCategory,
  type RequestStatus,
  type SessionInfo,
  type SessionRole,
} from "./api";
import {
  createKey,
  draftToInput,
  isEmptyPatch,
  loadStateFromError,
  patchFromDraft,
  saveStateFromError,
  ticketFor,
  updateKey,
  IDLE,
  PENDING,
  SAVED,
  type Draft,
  type LoadState,
  type SaveState,
  type WriteTicket,
} from "./state";

export interface Filters {
  status?: RequestStatus;
  category?: RequestCategory;
}

export interface Tracker {
  load: LoadState;
  session: SessionInfo | null;
  role: SessionRole | null;
  canWrite: boolean;
  retry: () => void;

  items: EquipmentRequest[];
  filters: Filters;
  setFilters: (next: Filters) => void;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  loadMore: () => void;

  selected: EquipmentRequest | null;
  open: (record: EquipmentRequest) => void;
  close: () => void;

  createState: SaveState;
  create: (draft: Draft) => Promise<boolean>;
  resetCreate: () => void;

  saveState: SaveState;
  save: (draft: Draft) => Promise<boolean>;
  /** re-base on the version the host holds and retry, keeping the draft */
  resolveConflict: (draft: Draft) => Promise<boolean>;
  /** give up the draft and take the version the host holds */
  discardConflict: () => EquipmentRequest | null;
  resetSave: () => void;

  leave: () => void;
}

const PAGE = TRACKER_LIMITS.listDefault;

export function useTracker(): Tracker {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoad, setSessionLoad] = useState<LoadState>({ kind: "loading" });
  const [listLoad, setListLoad] = useState<LoadState>({ kind: "loading" });
  const [items, setItems] = useState<EquipmentRequest[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<Filters>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EquipmentRequest | null>(null);
  const [createState, setCreateState] = useState<SaveState>(IDLE);
  const [saveState, setSaveState] = useState<SaveState>(IDLE);
  const [nonce, setNonce] = useState(0);

  const roleRef = useRef<SessionRole | null>(null);
  const createTicket = useRef<WriteTicket | null>(null);
  const saveTicket = useRef<WriteTicket | null>(null);

  useEffect(() => {
    let stale = false;
    setSessionLoad({ kind: "loading" });
    getSession().then(
      (info) => {
        if (stale) return;
        roleRef.current = info.role;
        setSession(info);
        setSessionLoad({ kind: "ready" });
      },
      (err: unknown) => {
        if (stale) return;
        setSessionLoad(loadStateFromError(err, roleRef.current));
      }
    );
    return () => {
      stale = true;
    };
  }, [nonce]);

  const ready = sessionLoad.kind === "ready";

  useEffect(() => {
    if (!ready) return undefined;
    let stale = false;
    setListLoad({ kind: "loading" });
    setMoreError(null);
    listRequests({ limit: PAGE, ...filters }).then(
      (page) => {
        if (stale) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setListLoad({ kind: "ready" });
      },
      (err: unknown) => {
        if (stale) return;
        setListLoad(loadStateFromError(err, roleRef.current));
      }
    );
    return () => {
      stale = true;
    };
  }, [ready, filters, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    listRequests({ limit: PAGE, cursor, ...filters }).then(
      (page) => {
        setItems((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (err: unknown) => {
        const state = loadStateFromError(err, roleRef.current);
        setMoreError("message" in state ? state.message : "That did not load.");
        setLoadingMore(false);
      }
    );
  }, [cursor, filters, loadingMore]);

  const create = useCallback(async (draft: Draft): Promise<boolean> => {
    const input = draftToInput(draft);
    const ticket = ticketFor(createTicket.current, createKey(input), newWriteId);
    createTicket.current = ticket;
    setCreateState(PENDING);
    try {
      const record = await createRequest(input, { writeId: ticket.id });
      createTicket.current = null;
      setItems((prev) => [record, ...prev.filter((item) => item.id !== record.id)]);
      setCreateState(SAVED);
      return true;
    } catch (err) {
      setCreateState(saveStateFromError(err, roleRef.current));
      return false;
    }
  }, []);

  const resetCreate = useCallback(() => setCreateState(IDLE), []);
  const resetSave = useCallback(() => setSaveState(IDLE), []);

  /**
   * `target` says which record and which version the write is against;
   * `base` is the version the draft was typed from, so the patch carries only
   * what this person actually changed. After a conflict those two differ, and
   * that is the whole point: re-basing keeps somebody else's edit to a field
   * this person never touched.
   */
  const commit = useCallback(
    async (target: EquipmentRequest, base: EquipmentRequestInput, draft: Draft): Promise<boolean> => {
      const patch = patchFromDraft(base, draft);
      if (isEmptyPatch(patch)) {
        setSelected(target);
        setSaveState(SAVED);
        return true;
      }
      const ticket = ticketFor(
        saveTicket.current,
        updateKey(target.id, target.version, patch),
        newWriteId
      );
      saveTicket.current = ticket;
      setSaveState(PENDING);
      try {
        const record = await updateRequest(
          target.id,
          { expectedVersion: target.version, patch },
          { writeId: ticket.id }
        );
        saveTicket.current = null;
        setSelected(record);
        setItems((prev) => prev.map((item) => (item.id === record.id ? record : item)));
        setSaveState(SAVED);
        return true;
      } catch (err) {
        setSaveState(saveStateFromError(err, roleRef.current));
        return false;
      }
    },
    []
  );

  const save = useCallback(
    async (draft: Draft): Promise<boolean> => {
      if (!selected) return false;
      return commit(selected, selected, draft);
    },
    [commit, selected]
  );

  /**
   * Send the same edits again, against the record the host returned with the
   * 409. The expected version is now theirs, so the write fingerprint changed
   * and a fresh write id is minted: this is a new intent, not a replay.
   */
  const resolveConflict = useCallback(
    async (draft: Draft): Promise<boolean> => {
      if (saveState.kind !== "conflict" || !selected) return false;
      // The base stays where it was until the edits actually land: it is what
      // the patch is measured against, and moving it early would make the
      // draft on screen look like it had been thrown away mid-save.
      return commit(saveState.current, selected, draft);
    },
    [commit, saveState, selected]
  );

  const discardConflict = useCallback((): EquipmentRequest | null => {
    if (saveState.kind !== "conflict") return null;
    const current = saveState.current;
    saveTicket.current = null;
    setSelected(current);
    setItems((prev) => prev.map((item) => (item.id === current.id ? current : item)));
    setSaveState(IDLE);
    return current;
  }, [saveState]);

  const open = useCallback((record: EquipmentRequest) => {
    saveTicket.current = null;
    setSaveState(IDLE);
    setSelected(record);
  }, []);

  const close = useCallback(() => {
    saveTicket.current = null;
    setSaveState(IDLE);
    setSelected(null);
  }, []);

  const leave = useCallback(() => {
    signOut().then(
      () => setSessionLoad({ kind: "signed_out" }),
      (err: unknown) => setSessionLoad(loadStateFromError(err, roleRef.current))
    );
  }, []);

  const role = session?.role ?? null;
  return {
    load: sessionLoad.kind === "ready" ? listLoad : sessionLoad,
    session,
    role,
    canWrite: role === "owner" || role === "editor",
    retry,
    items,
    filters,
    setFilters,
    hasMore: Boolean(cursor),
    loadingMore,
    moreError,
    loadMore,
    selected,
    open,
    close,
    createState,
    create,
    resetCreate,
    saveState,
    save,
    resolveConflict,
    discardConflict,
    resetSave,
    leave,
  };
}
