/**
 * Client-side file save. Security findings and the audit trail are exported
 * from what the screen already loaded, so neither round-trips through a server
 * to be read back — and both screens hand the browser the file the same way.
 */
/**
 * A cell, quoted. A leading =, +, - or @ is prefixed with an apostrophe:
 * spreadsheets treat those as formulas, and exported rows carry names, reasons
 * and summaries that people typed.
 */
function cell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Header row plus body, CRLF-terminated throughout — the framing Excel expects
 * from a .csv. Every value goes through the formula guard above, so a caller
 * cannot forget it on one column.
 */
export function csv(headers: string[], rows: unknown[][]): string {
  const body = rows.map((r) => r.map(cell).join(","));
  return [headers.join(","), ...body].join("\r\n") + "\r\n";
}

export function downloadFile(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
