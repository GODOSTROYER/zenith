/**
 * Test fixture: helpers shared by a provider's driver groups. The generator must
 * skip `shared`, even though this export looks like a driver.
 */
export const notAGroupDriver = {
  id: "kubernetes.shared_helper@1",
  provider: "kubernetes",
  nativeType: "k8s:Helper",
  capabilities: { compile: false, observe: false, runtime: false, verify: false, discover: false, operations: [], evidence: {} },
};
