"use client";
/**
 * The map's keyboard behaviour, kept out of the component that draws it:
 * where focus goes when a panel closes, and what Escape and "/" do.
 *
 * The roving tab stop itself lives on the nodes (see nodes.tsx) — these two
 * hooks are the parts that need the React Flow instance or a window listener.
 */
import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import type { useReactFlow } from "@xyflow/react";
import type { Binding } from "@/lib/domain/types";
import type { InspectorTarget } from "@/components/inspector/inspector";

type FlowApi = ReturnType<typeof useReactFlow>;

export interface NodeFocus {
  /** Bring a node into view without changing the zoom the user chose. */
  centerOn: (id: string) => void;
  /** Escape out of the inspector puts the caret back where it came from. */
  focusNode: (id: string) => void;
}

export function useNodeFocus(rf: FlowApi): NodeFocus {
  const centerOn = useCallback(
    (id: string) => {
      const n = rf.getNode(id);
      if (!n) return;
      const w = n.width ?? n.measured?.width ?? 200;
      const h = n.height ?? n.measured?.height ?? 80;
      rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
        zoom: rf.getZoom(),
        // Read at activation so a changed OS preference takes effect without
        // remounting the graph or resetting its selection and viewport.
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
      });
    },
    [rf]
  );

  const focusNode = useCallback((id: string) => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-map-node][data-node-id="${CSS.escape(id)}"]`)
        ?.focus();
    });
  }, []);

  return { centerOn, focusNode };
}

export interface MapKeyboardOptions {
  searchRef: RefObject<HTMLInputElement | null>;
  /** the node whose context menu is open, or null */
  menuNodeId: string | null;
  binding: boolean;
  target: InspectorTarget | null;
  bindings: Binding[];
  focusNode: (id: string) => void;
  closeMenu: () => void;
  exitBind: () => void;
  /** `back` is the node focus should return to, when there is one */
  closeTarget: (back: string | undefined) => void;
}

/** Escape unwinds one layer at a time — menu, then bind mode, then the panel. */
export function useMapKeyboard({
  searchRef,
  menuNodeId,
  binding,
  target,
  bindings,
  focusNode,
  closeMenu,
  exitBind,
  closeTarget,
}: MapKeyboardOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      // "/" is the find shortcut everywhere else; it is here too.
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key !== "Escape") return;
      if (menuNodeId) {
        closeMenu();
        focusNode(menuNodeId);
      } else if (binding) exitBind();
      else if (target) {
        // Focus came from a node, so it goes back to that node — not to the
        // top of the document, which is where it landed before.
        closeTarget(
          target.kind === "node"
            ? target.nodeId
            : target.kind === "binding"
              ? bindings.find((b) => b.id === target.bindingId)?.from
              : undefined
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    searchRef,
    menuNodeId,
    binding,
    target,
    bindings,
    focusNode,
    closeMenu,
    exitBind,
    closeTarget,
  ]);
}
