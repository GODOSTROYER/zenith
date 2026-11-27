/** Continuation tokens are allowed; credentials and signed URL secrets are not evidence. */
export function hasCredentialQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => {
    // These are the native pagination fields emitted by the supported APIs.
    // Other token aliases (including OAuth refresh/ID and session tokens) can
    // carry credentials and must not become catalog evidence or API output.
    if (/^(?:NextToken|pageToken|\$skiptoken)$/i.test(key)) return false;
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    return /^(?:key|sig|code|auth|bearer)$/.test(normalized) ||
      /(?:token|secret|password|credential|signature|authorization|assertion|apikey|accesskey)/.test(normalized);
  });
}
