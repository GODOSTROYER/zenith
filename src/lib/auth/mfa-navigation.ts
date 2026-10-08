/** Client-safe. A step-up returns to review; it never replays a privileged request. */
export function mfaReturnPath(raw?: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f]/.test(raw)) return "/platform";
  try {
    const url = new URL(raw, "https://zenith.invalid");
    if (url.origin !== "https://zenith.invalid" || !/^\/(platform|account)(\/|$)/.test(url.pathname)) return "/platform";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/platform"; }
}
