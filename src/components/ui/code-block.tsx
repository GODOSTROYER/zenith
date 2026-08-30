import type { ReactNode } from "react";
import { cx } from "@/lib/format";
import { CopyButton } from "./copy-button";

export interface CodeBlockProps {
  code: string;
  /** shown top-left, e.g. "main.tf" or "json" */
  title?: ReactNode;
  lineNumbers?: boolean;
  /** scroll past this height (px) */
  maxHeight?: number;
  copy?: boolean;
  wrap?: boolean;
  className?: string;
}

/** Mono 12.5px code surface with optional line numbers and a copy button. */
export function CodeBlock({
  code,
  title,
  lineNumbers = false,
  maxHeight = 320,
  copy = true,
  wrap = false,
  className,
}: CodeBlockProps) {
  const lines = code.replace(/\n$/, "").split("\n");
  const gutter = String(lines.length).length;

  return (
    <div
      className={cx(
        "group relative overflow-hidden rounded-card border border-line bg-bg1",
        className
      )}
    >
      {(title || copy) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5">
          <span className="truncate font-mono text-[11.5px] text-ink-faint">{title}</span>
          {copy && <CopyButton value={code} what="code" />}
        </div>
      )}
      <div className="overflow-auto" style={{ maxHeight }}>
        <pre
          className={cx(
            "font-mono text-[12.5px] leading-[1.65] text-ink",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          )}
        >
          {lineNumbers ? (
            <code className="grid">
              {lines.map((line, i) => (
                <span key={i} className="grid grid-cols-[auto_1fr] gap-4 px-3">
                  <span
                    className="tnum select-none text-right text-ink-faint"
                    style={{ width: `${gutter}ch` }}
                  >
                    {i + 1}
                  </span>
                  <span>{line || " "}</span>
                </span>
              ))}
            </code>
          ) : (
            <code className="block px-3 py-2.5">{code}</code>
          )}
        </pre>
      </div>
    </div>
  );
}
