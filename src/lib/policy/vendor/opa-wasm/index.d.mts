import type { loadPolicy as UpstreamLoadPolicy } from "./opa.js";
/** Published OPA1.10.0 loadPolicy type; the runtime remains the original loader. */
export declare const loadPolicy: typeof UpstreamLoadPolicy;
declare const opa: { loadPolicy: typeof UpstreamLoadPolicy };
export default opa;
