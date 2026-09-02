/**
 * Client-side file save. Security findings and the audit trail are exported
 * from what the screen already loaded, so neither round-trips through a server
 * to be read back — and both screens hand the browser the file the same way.
 */
export function downloadFile(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
