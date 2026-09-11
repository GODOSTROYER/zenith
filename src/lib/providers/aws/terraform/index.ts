/**
 * The exporter's public surface. `@/lib/providers/aws/terraform` resolves
 * here, so every import that predates the split keeps working; the modules
 * behind it are free to move.
 */
export { hclBody, hclComment, hclNum, hclString } from "./hcl";
export { allocateStableNames, fargateSpec } from "./naming";
export { containerEnv, type ContainerEnv } from "./container-env";
export { terraformFiles } from "./bundle";
export { terraformReadme } from "./readme";
