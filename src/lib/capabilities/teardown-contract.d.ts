/** C1 contracts supplied by parallel provider jobs; declarations provide no runtime implementation. */
declare module "@/lib/providers/kubernetes/teardown" {
  export const teardownKubernetesEnvironment: (input: import("@/lib/execution/destroy").TeardownInput) => Promise<import("@/lib/execution/destroy").TeardownResult>;
}
declare module "@/lib/providers/zenith/teardown" {
  export const teardownZenithEnvironment: (input: import("@/lib/execution/destroy").TeardownInput) => Promise<import("@/lib/execution/destroy").TeardownResult>;
}
