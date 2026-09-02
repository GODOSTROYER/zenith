/**
 * Where JSON.parse gave up, in terms a human can act on.
 *
 * The engine tells you a character offset ("at position 1287"), and newer V8
 * also volunteers a line/column it makes no promises about. Neither form is
 * useful in a 2000-line manifest until it is turned into a line, a column and
 * an offset the editor can select. Pure and engine-agnostic on purpose: the
 * message format is the one thing here that changes under us.
 */

export interface JsonErrorSite {
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  /** character offset into the text, clamped to it */
  offset: number;
}

/** 1-based line/column of `offset` in `text`. Offsets outside the text clamp. */
export function offsetToLineCol(text: string, offset: number): JsonErrorSite {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: at - lineStart + 1, offset: at };
}

/** Inverse of the above, for engines that report line/column but no position. */
export function lineColToOffset(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  const idx = Math.max(0, Math.min(line - 1, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < idx; i++) offset += lines[i].length + 1;
  return Math.min(offset + Math.max(0, column - 1), text.length);
}

const POSITION = /at position (\d+)/;
const LINE_COLUMN = /line (\d+) column (\d+)/;
const UNEXPECTED_END = /unexpected end of (json|input)/i;

/** Locate a parser message against the text it failed on, if it said where. */
export function jsonErrorSite(text: string, message: string): JsonErrorSite | undefined {
  const pos = POSITION.exec(message);
  if (pos) return offsetToLineCol(text, Number(pos[1]));

  const lc = LINE_COLUMN.exec(message);
  if (lc) {
    const line = Number(lc[1]);
    const column = Number(lc[2]);
    return { line, column, offset: lineColToOffset(text, line, column) };
  }

  // "Unexpected end of JSON input" carries no position: it is always the end.
  if (UNEXPECTED_END.test(message)) return offsetToLineCol(text, text.length);
  return undefined;
}

/** Strip the engine's own position tail; we re-state it up front instead. */
function detailOf(message: string): string {
  return (
    message
      .replace(/\s*in JSON at position \d+(\s*\(line \d+ column \d+\))?/i, "")
      .replace(/\s*\(line \d+ column \d+\)/i, "")
      .replace(/[.\s]+$/, "")
      .trim() || "The JSON could not be parsed"
  );
}

/** A parse failure as the editor shows it: line and column first, then why. */
export function describeJsonError(
  text: string,
  error: unknown
): { message: string; site?: JsonErrorSite } {
  const raw = error instanceof Error ? error.message : String(error);
  const site = jsonErrorSite(text, raw);
  const detail = detailOf(raw);
  return {
    message: site
      ? `Line ${site.line}, column ${site.column}: ${detail}. Fix the JSON syntax — the manifest has to parse before anything can be checked.`
      : `${detail}. Fix the JSON syntax — the manifest has to parse before anything can be checked.`,
    site,
  };
}
