/** Fail-closed guards shared by the VM and OKE compilers. Errors never echo inputs. */
import { load } from "js-yaml";
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { findInlineSecretPaths } from "@/lib/resources/secrets";
import { OciCompileError } from "../../errors";
import { networkOf } from "../../naming";
import { asRecord } from "../../observe-kit";
import { isOcid } from "../../services";

export function imageId(node: ResourceNode, value: unknown): string {
  if (!isOcid(value) || !value.startsWith("ocid1.image.")) throw new OciCompileError(`${node.address}: an image OCID is required.`);
  return value;
}

export function boundedNumber(node: ResourceNode, name: string, value: unknown, fallback: number, min: number, max: number, integer = true): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new OciCompileError(`${node.address}: ${name} must be ${integer ? "an integer" : "a number"} in ${min}..${max}.`);
  return n;
}

export function flexibleShape(node: ResourceNode, value: unknown = "VM.Standard.E4.Flex"): string {
  if (typeof value !== "string" || !["VM.Standard.E4.Flex", "VM.Standard.E5.Flex", "VM.Standard.A1.Flex"].includes(value)) throw new OciCompileError(`${node.address}: a supported flexible VM shape is required.`);
  return value;
}

export function privatePlacement(ctx: CompileContext, node: ResourceNode) {
  const placement = networkOf(ctx, node, "private");
  const network = ctx.node(placement.network);
  if (!network || network.provider !== "oci" || network.nativeType !== "oci:vcn" || network.region !== node.region) throw new OciCompileError(`${node.address}: private subnets must belong to an OCI VCN in the same region.`);
  for (const address of placement.subnets) {
    const subnet = ctx.node(address)!;
    if (subnet.provider !== "oci" || subnet.nativeType !== "oci:subnet" || subnet.region !== node.region || subnet.spec.network !== placement.network) throw new OciCompileError(`${node.address}: private subnets must share the same OCI VCN and region.`);
  }
  return placement;
}

/** Heuristics complement the graph's no-secret contract; arbitrary text cannot be proven secret-free. */
export function cloudInitMetadata(node: ResourceNode, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.startsWith("#cloud-config\n") || Buffer.byteLength(value) > 24_000) throw new OciCompileError(`${node.address}: cloudInit must be bounded #cloud-config YAML.`);
  let parsed: unknown;
  try { parsed = load(value); } catch { throw new OciCompileError(`${node.address}: cloudInit is invalid YAML.`); }
  if (!asRecord(parsed) || findInlineSecretPaths(parsed).length || /secretRef|BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|token|api[_-]?key|secret)\s*[=:]|https?:\/\/[^\s/]+@/i.test(value)) throw new OciCompileError(`${node.address}: cloudInit cannot contain credentials or secret references.`);
  // Base64 is literal even if the YAML contains Terraform interpolation syntax.
  return { user_data: Buffer.from(value, "utf8").toString("base64") };
}
