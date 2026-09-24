"use client";
/**
 * The workspace's name, renamed through a plan. Shared by the project settings
 * screen and the workspace-level /settings page.
 */
import { useState } from "react";
import type { Workspace } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function WorkspaceCard({
  workspace,
  disabledReason,
  onRename,
}: {
  workspace: Workspace;
  /** why renaming is not this member's to do, when that is the case */
  disabledReason: string | undefined;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const trimmed = name.trim();
  const tooShort = trimmed.length < 2;
  const unchanged = trimmed === workspace.name;

  return (
    <Card
      title={workspace.name}
      subtitle={
        <>
          <span className="break-all font-mono">{workspace.slug}</span> · workspace links keep this slug when the name changes
        </>
      }
    >
      <Field
        label="Workspace name"
        help="Shown in navigation and workspace switching. Existing links and audit history are preserved."
        error={!tooShort || name === "" ? undefined : "Use at least 2 characters."}
      >
        <div className="flex flex-wrap gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="min-w-[180px] flex-1"
            disabled={!!disabledReason}
          />
          <Button
            variant="quiet"
            disabled={tooShort || unchanged || !!disabledReason}
            disabledReason={
              disabledReason ??
              (tooShort
                ? "A workspace name needs at least 2 characters."
                : "This is already the workspace name.")
            }
            onClick={() => onRename(trimmed)}
          >
            Preview and rename
          </Button>
        </div>
      </Field>
    </Card>
  );
}
