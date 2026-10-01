/**
 * OCI graph specs for kinds expansion does not produce yet. These are desired
 * inputs, never credentials. Image OCIDs and Kubernetes versions are explicit:
 * compilation never guesses an image or silently selects a newer version.
 */
export interface ComputeInstanceSpec {
  imageOcid: string;
  shape?: "VM.Standard.E4.Flex" | "VM.Standard.E5.Flex" | "VM.Standard.A1.Flex";
  ocpus?: number;
  memoryGb?: number;
  bootVolumeGb?: number;
  /** Non-secret #cloud-config YAML; supplied only through metadata.user_data. */
  cloudInit?: string;
  deletionPolicy?: "deny" | "approval" | "allow";
}

export interface OkeClusterSpec {
  version: string;
  nodeImageOcid: string;
  nodeCount?: number;
  nodeShape?: ComputeInstanceSpec["shape"];
  nodeOcpus?: number;
  nodeMemoryGb?: number;
  /** Private API clients; broad internet CIDRs are refused. */
  apiAccessCidrs?: string[];
  deletionPolicy?: "deny" | "approval" | "allow";
}
