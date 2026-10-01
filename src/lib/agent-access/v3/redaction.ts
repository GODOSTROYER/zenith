/** The shared broker scrubber covers values. MCP also scrubs object keys:
 * provider-native bags can put credential-shaped text in either position. */
import { scrubSecrets } from "@/lib/capabilities/secret-guard";

export function scrubMcpValue<T>(value: T): T {
  const walkKeys = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walkKeys);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [scrubSecrets(key), walkKeys(child)]));
    }
    return node;
  };
  // The scrubber bounds node count and depth before we walk the sanitized tree.
  return walkKeys(scrubSecrets(value)) as T;
}
