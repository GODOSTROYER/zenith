/** Bound response bodies while the request's abort deadline remains active. */
export async function responseText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Response body exceeds the acceptance limit.");
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}
/** Exact configured tokens are removed even when they do not match heuristics. */
export function removeToken(text: string, token: string | undefined): string { return token ? text.split(token).join("[REDACTED TOKEN]") : text; }
