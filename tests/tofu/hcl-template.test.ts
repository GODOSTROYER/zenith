/** Scanner/policy contract tests; no OpenTofu or network required. */
import { describe, expect, it } from "vitest";
import { expressionRefusal } from "@/lib/tofu/expression-policy";
import { HclTemplateError, scanHclTemplate } from "@/lib/tofu/hcl-template";
import { secVectors, upperCorpus } from "./_expression-vectors";

const types = new Set(["terraform_data", "aws_instance", "oci_core_vnic"]);
const refused = (source: string) => {
  try { return expressionRefusal(source, types) !== undefined; }
  catch (e) { expect(e).toBeInstanceOf(HclTemplateError); return true; }
};

describe("fail-closed HCL expression policy", () => {
  it.each(secVectors)("refuses SEC-F5 vector %s", (source) => expect(refused(source)).toBe(true));

  it.each([
    '${core::file("x")}', '${core /**/ :: file /**/ ("x")}',
    '${provider::x::y("x")}', '${provider /*c*/ :: x :: y ("x")}',
    '${"nested ${file/**/("x")}"}', '${<<EOT\n${file/**/("x")}\nEOT\n}',
    '${[for v in ["x"] : file/**/(v)]}', '${~ file/**/("x") ~}',
    '${path["cwd"]}', '${(path).cwd}', '${terraform /**/ . workspace}', '${terraform.anything}',
    '${filebase64("x")}', '${fileset("x", "*")}', '${filemd5("x")}',
    '${filebase64sha256("x")}', '${filebase64sha512("x")}', '${filesha1("x")}',
    '${filesha256("x")}', '${filesha512("x")}', '${pathexpand("x")}', '${abspath("x")}',
    '${templatestring("x", {})}', '${totally_unknown("x")}', '${unknown_root.x}',
    ...["", "/**/", " /* c */ ", " # c\n", " // c\n"].map((c) => `\${nonsensitive${c}("x")}`),
    ...["timestamp", "plantimestamp", "uuid", "bcrypt"].map((fn) => `\${${fn}()}`),
    '${jsonencode({ (path.cwd) = "x" })}', '${jsonencode({ path.cwd = "x" })}',
    '${"${nonsensitive/**/(var.secret)}"}', '${<<EOT\n${nonsensitive/**/(var.secret)}\nEOT\n}',
    '\\${file("x")}', '\\%{ if true }${file("x")}%{ endif }',
  ])("refuses forbidden dependency %s", (source) => expect(refused(source)).toBe(true));

  it.each([
    "${", '${upper("x")', '${upper("x)}', '${upper(/*', '${upper(//}',
    '${<<EOT\nmissing}', '${<<-EOT\nmissing}', '${"bad\\q"}', '${"bad\\uZZZZ"}',
    '${"bad\\UFFFFFFFF"}', '${"bad\\uD800"}', '${1 @ 2}', '${1;2}', '${[]', '${{x=1}',
    '${[for v in [] v]}', '${jsonencode({path cwd="x"})}', '${unknown::name}',
    '%{ if true }missing endif', '%{ for v in [] }missing endfor', '%{ endif }',
    '%{ else }', '%{ if true }%{ endfor }', '%{ if true }%{ else }%{ else }%{ endif }',
    '%{ mystery true }', '${~}', '${1 ~ }', '${"line\nbreak"}', '${\v1}',
  ])("rejects unknown or unterminated syntax %s", (source) => {
    expect(() => scanHclTemplate(source)).toThrow(HclTemplateError);
  });

  it.each(upperCorpus)("accepts harmless corpus %s", (source) => expect(refused(source)).toBe(false));

  it("distinguishes bare object keys, attributes, bindings and root references", () => {
    const scan = scanHclTemplate('${jsonencode({path="x", terraform="x", file="x", x=local.path, y=[for v in var.items : upper(v.name)]})}');
    expect([...scan.calls].sort()).toEqual(["jsonencode", "upper"]);
    expect([...scan.roots].sort()).toEqual(["local", "var"]);
    expect(expressionRefusal('${jsonencode({path="x", terraform="x"})}', types)).toBeUndefined();
    expect(scanHclTemplate('${{for k, v in local.items : k => v.id if v.enabled}}').roots).toEqual(new Set(["local"]));
    expect(scanHclTemplate('%{ for v in var.items }${v.path}%{ endfor }${v.path}').roots).toEqual(new Set(["var", "v"]));
  });

  it.each(['$${file("x")}', '%%{ if }', '$$${file("x")}', '%%%{ if }'])("treats escapes as literal %s", (source) => {
    const scan = scanHclTemplate(source);
    expect(scan.calls.size).toBe(0);
    expect(scan.roots.size).toBe(0);
    expect(scan.pureLiteral).toBe(false); // tofu unescapes the literal introducer
    expect(expressionRefusal(source, types)).toBeUndefined();
  });

  it("handles driver-shaped operators, traversals, splats and argument expansion", () => {
    for (const source of [
      '${join(",", aws_instance.web[*].id)}', '${aws_instance.web.*.id}',
      '${oci_core_vnic.x[count.index].private_ip_address}', '${count.index % 3 + 1}',
      '${var.enabled && !var.disabled ? local.x : local.y}', '${max([1, 2, 3]...)}',
      '${jsonencode({ a=1\n b=2\n path="x" })}', '${format("%s", each.key)}',
      '${var.items.0}', '${1.2e-3 + -2}', '${"\\u0024{file(\\"x\\")}"}',
      '${jsonencode({ for="literal", in="literal", if="literal" })}',
      '${merge(var.maps...).path}', '${join(",", [for path in var.items : path.name])}',
    ]) expect(expressionRefusal(source, types), source).toBeUndefined();
  });

  it("ignores comment and literal text that mentions hostile expressions", () => {
    const scan = scanHclTemplate('${upper/* file("x") ${ */("zz")}');
    expect(scan.calls).toEqual(new Set(["upper"]));
    expect(scanHclTemplate('literal file("x") /* # */').pureLiteral).toBe(true);
  });

  it("refuses excessive nesting without a stack overflow", () => {
    expect(() => scanHclTemplate(`\${${"(".repeat(200)}1${")".repeat(200)}}`)).toThrow(HclTemplateError);
    expect(() => scanHclTemplate(`${"%{ if true }".repeat(200)}text${"%{ endif }".repeat(200)}`)).toThrow(HclTemplateError);
    expect(() => scanHclTemplate('${<<EOT\n\uFEFFEOT\n${file("x")}\nEOT\n}')).not.toThrow();
    expect(scanHclTemplate('${<<EOT\n\uFEFFEOT\n${file("x")}\nEOT\n}').calls).toEqual(new Set(["file"]));
  });
});
