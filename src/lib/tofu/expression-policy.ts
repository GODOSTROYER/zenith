/**
 * Closed expression policy: only deterministic, in-memory functions and known
 * roots. Provider/core namespaces, declassification, filesystem access and
 * time/randomness functions cannot enter this allowlist implicitly.
 */
import { scanHclTemplate } from "@/lib/tofu/hcl-template";

// Fixture compilation inventories are asserted in tests/tofu/driver-expressions.
// Additions must be pure; never permit file/template/path functions or namespaces.
const PURE_FUNCTIONS: ReadonlySet<string> = new Set([
  "abs", "ceil", "floor", "log", "max", "min", "parseint", "pow", "signum",
  "chomp", "format", "formatlist", "indent", "join", "lower", "regex", "regexall",
  "replace", "split", "strcontains", "strrev", "substr", "title", "trim",
  "trimprefix", "trimsuffix", "trimspace", "upper", "startswith", "endswith",
  "alltrue", "anytrue", "chunklist", "coalesce", "coalescelist", "compact",
  "concat", "contains", "distinct", "element", "flatten", "index", "keys",
  "length", "lookup", "matchkeys", "merge", "one", "range", "reverse",
  "setintersection", "setproduct", "setsubtract", "setunion", "slice", "sort",
  "sum", "transpose", "values", "zipmap",
  "base64decode", "base64encode", "base64gzip", "csvdecode", "jsondecode",
  "jsonencode", "textdecodebase64", "textencodebase64", "urlencode",
  "yamldecode", "yamlencode", "md5", "sha1", "sha256", "sha512",
  "base64sha256", "base64sha512",
  "cidrhost", "cidrnetmask", "cidrsubnet", "cidrsubnets", "cidrcontains",
  "can", "try", "tobool", "tolist", "tomap", "tonumber", "toset", "tostring",
  "sensitive", "issensitive",
]);
const STANDARD_ROOTS: ReadonlySet<string> = new Set(["local", "var", "data", "self", "count", "each"]);

/** Returns a redaction-safe reason; syntax diagnostics contain offsets only. */
export function expressionRefusal(source: string, resourceTypes: ReadonlySet<string>): string | undefined {
  // Most driver strings are literal. Avoid per-character scanning on this path.
  if (!source.includes("${") && !source.includes("%{")) return;
  const scan = scanHclTemplate(source);
  for (const call of scan.calls) {
    if (!PURE_FUNCTIONS.has(call)) return `function ${call}() is not allowed`;
  }
  for (const root of scan.roots) {
    if (root === "path" || root === "terraform" || (!STANDARD_ROOTS.has(root) && !resourceTypes.has(root))) {
      return `reference root ${root} is not allowed`;
    }
  }
}
