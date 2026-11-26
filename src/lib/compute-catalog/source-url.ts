/** Continuation tokens are allowed; credentials and signed URL secrets are not evidence. */
export function hasCredentialQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) =>
    /^(key|token|sig|code|clientsecret|client_assertion|bearer)$/i.test(key) ||
    /(?:^|[-_])(?:secret|password|credential|signature|authorization|access[-_]?token|api[-_]?key|security[-_]?token)(?:$|[-_])/i.test(key),
  );
}
