"use client";
/**
 * One plan per fixable finding, for the whole screen. Planning is read-only
 * and open to every role, so this is also how a row knows a fix would be
 * refused before anyone clicks it.
 *
 * TODO(ceiling): one request per fixable finding, in parallel. A batch plan
 * endpoint if a project ever carries enough findings for that to matter.
 */
import { useEffect, useRef, useState } from "react";
import { planAction } from "@/lib/client/api";
import type { SecurityFinding } from "@/lib/domain/types";
import { errorText, type Scope } from "@/components/screens/shared";
import type { FixRow } from "./rows";

export function useFixPlans(
  findings: SecurityFinding[],
  scope: Scope
): { rows: FixRow[]; at: string } | undefined {
  const [state, setState] = useState<{ rows: FixRow[]; at: string }>();

  const list = useRef(findings);
  list.current = findings;
  const idKey = findings.map((f) => f.id).join(",");
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let alive = true;
    setState(undefined);
    const s = JSON.parse(scopeKey) as Scope;
    Promise.all(
      list.current.map((finding) =>
        planAction("security.resolveFinding", {
          input: { findingId: finding.id, applyFix: true },
          scope: s,
        })
          .then((plan): FixRow => ({ finding, plan }))
          .catch((e: unknown): FixRow => ({ finding, error: errorText(e).message }))
      )
    ).then((rows) => alive && setState({ rows, at: new Date().toISOString() }));
    return () => {
      alive = false;
    };
  }, [idKey, scopeKey]);

  return state;
}
