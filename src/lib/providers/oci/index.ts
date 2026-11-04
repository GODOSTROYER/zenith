/**
 * Oracle Cloud Infrastructure provider: resource drivers (ADR-0004), native API
 * access through the customer's runner (ADR-0006, ADR-0010).
 *
 * Public surface:
 *   - `ociDrivers` / `registerOciDrivers()`   the drivers
 *   - `OciApiTransport`, `OciSession`         the port the credential broker's
 *                                             `runner` mode must implement
 *   - `ociCompileContext()`                   scope a `CompileContext` with the
 *                                             connection's compartment/tenancy
 *   - `ociPrimaryAddress()`                   the tofu address `ctx.ref()` targets
 *   - `syncSecretValue()`                     write a Vault secret value
 */
export { ociDrivers, registerOciDrivers } from "./drivers";
export { ociCompileContext, type OciCompileContext } from "./context";
export { OciCompileError, OciUnsupportedError } from "./errors";
export { ociPrimaryAddress, tfLabel, zenithTags } from "./naming";
export { syncSecretValue } from "./ops/secret-sync";
export { OCI_SERVICE_HOSTS, isOcid, type OciServiceId } from "./services";
export { ociCall, type OciApiRequest, type OciApiResponse, type OciApiTransport, type OciHttpMethod, type OciSession } from "./transport";
