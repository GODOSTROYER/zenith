/**
 * The driver-inertness helper proves itself (WS-SEC), and is pointed at the one
 * place in this repository that already turns node strings into generated
 * infrastructure text: the legacy Terraform HCL exporter
 * (src/lib/providers/aws/terraform/hcl.ts), whose header describes the same
 * escaping rule the new drivers must follow.
 *
 * The new drivers (WS-AWS-NET, WS-AWS-CMP, WS-AWS-DATA, WS-K8S, …) do not exist
 * on this branch. Each of them must add, to its contract test:
 *
 *     assertDriverStringsInert({ label: driver.id, leaves: [...], compile: (attack, leaf) => driver.compile!(withLeaf(node, leaf, attack), ctx) });
 *
 * (see tests/security/README.md, "pending hooks").
 */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { assertDriverStringsInert, EXPRESSION_ATTACKS, liveInterpolations, liveSnippetsOf } from "../_support/security";

describe("liveInterpolations: the HCL escaping rule", () => {
  it("a bare ${ or %{ is live; $${ and %%{ are literal; a second escape character in front makes it literal", () => {
    expect(liveInterpolations("a ${x} b")).toHaveLength(1);
    expect(liveInterpolations("a %{ if x }b")).toHaveLength(1);
    expect(liveInterpolations("a $${x} b")).toEqual([]);
    expect(liveInterpolations("a %%{ if x }b")).toEqual([]);
    // verified against real tofu: two or more escape characters in front of the brace are always literal
    expect(liveInterpolations("$$${x}")).toEqual([]);
    expect(liveInterpolations("$$$${x}")).toEqual([]);
    expect(liveInterpolations("$$ ${x}")).toHaveLength(1);
    expect(liveInterpolations("${a}${b}")).toHaveLength(2);
    expect(liveInterpolations("no braces $ here % there")).toEqual([]);
  });
});

/** A fragment with one attribute plus one legitimate reference a driver must be free to emit. */
const fragmentWith = (name: string): TofuFragment => ({
  resource: { aws_ecs_service: { web: { name, cluster: "${aws_ecs_cluster.main.id}" } } },
  addresses: ["aws_ecs_service.web"],
});

// (a replacement FUNCTION: in a replacement string "$$" means one literal "$", which would silently make this a no-op)
const escape = (s: string) => s.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");

describe("assertDriverStringsInert", () => {
  it("passes a driver that escapes node strings and still emits its own references", () => {
    expect(() => assertDriverStringsInert({ label: "good-driver", leaves: ["name", "image"], compile: (attack) => fragmentWith(escape(attack)) })).not.toThrow();
  });

  it("passes a driver that refuses hostile strings outright", () => {
    expect(() =>
      assertDriverStringsInert({
        label: "strict-driver",
        leaves: ["name"],
        compile: (attack) => {
          if (/[${}%]/.test(attack)) throw new Error("invalid name");
          return fragmentWith(attack);
        },
      })
    ).not.toThrow();
  });

  it("fails a driver that copies node strings into the configuration verbatim, naming the leaf and the payload", () => {
    expect(() => assertDriverStringsInert({ label: "naive-driver", leaves: ["name"], compile: (attack) => fragmentWith(attack) })).toThrow(
      /SECURITY INVARIANT VIOLATED: driver output carries text from the node as live OpenTofu interpolation[\s\S]*naive-driver: leaf "name"/
    );
  });

  it("fails a driver that escapes only some payloads (an incomplete escape is the classic bug)", () => {
    const halfEscaped = (s: string) => s.replace(/\$\{file/g, () => "$${file"); // forgets %{ and every other function
    expect(() => assertDriverStringsInert({ label: "half-driver", leaves: ["name"], compile: (attack) => fragmentWith(halfEscaped(attack)) })).toThrow(/half-driver/);
  });

  it("catches a payload planted in an object KEY, not just a value", () => {
    const keyed = (attack: string): TofuFragment => ({ resource: { aws_ecs_service: { web: { tags: { [attack]: "x" } } } }, addresses: ["aws_ecs_service.web"] });
    expect(() => assertDriverStringsInert({ label: "key-driver", leaves: ["tag"], compile: (attack) => keyed(attack) })).toThrow(/key-driver/);
  });

  it("the expression attack list is non-trivial and includes the comment-hidden function call", () => {
    expect(EXPRESSION_ATTACKS.length).toBeGreaterThan(20);
    expect(EXPRESSION_ATTACKS.some((a) => a.includes("file/**/("))).toBe(true);
    expect(liveSnippetsOf(fragmentWith("x")).size).toBe(1);
  });
});
