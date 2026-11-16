/**
 * The pure helpers behind the compute drivers: Fargate sizing, cron
 * translation, image references, fragment rendering/escaping and the
 * least-privilege policy check.
 */
import { describe, expect, it } from "vitest";
import { FARGATE_TIERS, fargateSize } from "@/lib/providers/aws/drivers/compute/support/fargate";
import { CronError, toEventBridgeCron } from "@/lib/providers/aws/drivers/compute/support/cron";
import { ImageRefError, ecrCoordinates, parseImageRef } from "@/lib/providers/aws/drivers/compute/support/image";
import {
  ComputeCompileError,
  TfRef,
  assertLeastPrivilege,
  cat,
  dependsOnTarget,
  escapeTemplate,
  policyJson,
  rawRef,
  render,
  renderJsonText,
} from "@/lib/providers/aws/drivers/compute/support/tf";
import { mkCompileContext, buildFixture } from "./fixtures";
import { refOf } from "@/lib/providers/aws/drivers/compute/support/tf";

describe("fargateSize", () => {
  const cases: [number, number, number, number, boolean][] = [
    // vcpu, memoryMb → cpu units, memoryMb, rounded
    [0.25, 256, 256, 512, true], // `nano`: 256 MB does not exist at 0.25 vCPU
    [0.25, 512, 256, 512, false],
    [0.25, 2048, 256, 2048, false],
    [0.5, 512, 512, 1024, true], // `small`
    [0.5, 1024, 512, 1024, false],
    [1, 1024, 1024, 2048, true], // `standard`
    [1, 2048, 1024, 2048, false],
    [2, 4096, 2048, 4096, false], // `performance`
    [0.25, 4096, 512, 4096, true], // memory too big for the 0.25 tier: next cpu tier up
    [1, 9000, 2048, 9216, true], // 1 vCPU tops out at 8 GB: next tier, next 1 GB step
    [3, 4096, 4096, 8192, true], // 3 vCPU is not a size: 4 vCPU with its 8 GB minimum
    [8, 17000, 8192, 20480, true], // 4 GB steps above 16 GB
    [16, 122880, 16384, 122880, false],
    [0.1, 100, 256, 512, true],
  ];
  it.each(cases)("%s vCPU / %s MB → %s units / %s MB (rounded: %s)", (vcpu, mem, cpu, memory, rounded) => {
    const s = fargateSize(vcpu, mem);
    expect(s).toMatchObject({ cpu, memoryMb: memory, rounded });
    expect(s.requested).toEqual({ vcpu, memoryMb: mem });
    if (rounded) expect(s.note).toMatch(/rounded up/);
    else expect(s.note).toBeUndefined();
  });

  it("only ever returns a combination Fargate accepts, never rounds down, and is monotonic", () => {
    let previous = 0;
    for (const vcpu of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]) {
      for (const memoryMb of [128, 256, 512, 900, 1024, 1500, 2048, 3000, 4096, 6000, 8192, 10000, 16384, 20000, 32768, 65536, 100000]) {
        let s;
        try {
          s = fargateSize(vcpu, memoryMb);
        } catch (e) {
          expect(e).toBeInstanceOf(ComputeCompileError);
          continue;
        }
        const tier = FARGATE_TIERS.find((t) => t.cpu === s.cpu)!;
        expect(tier, `${vcpu}/${memoryMb}`).toBeDefined();
        expect(s.memoryMb).toBeGreaterThanOrEqual(tier.minMb);
        expect(s.memoryMb).toBeLessThanOrEqual(tier.maxMb);
        expect((s.memoryMb - tier.minMb) % tier.stepMb).toBe(0);
        expect(s.cpu).toBeGreaterThanOrEqual(vcpu * 1024);
        expect(s.memoryMb).toBeGreaterThanOrEqual(memoryMb);
      }
      previous += 1;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("rejects sizes Fargate cannot run and malformed input", () => {
    expect(() => fargateSize(32, 1024)).toThrow(/No Fargate task size/);
    expect(() => fargateSize(16, 200000)).toThrow(/No Fargate task size/);
    for (const bad of [0, -1, NaN, Infinity, "1", undefined, null]) expect(() => fargateSize(bad, 1024)).toThrow(ComputeCompileError);
    for (const bad of [0, -5, NaN, "512", undefined]) expect(() => fargateSize(1, bad)).toThrow(ComputeCompileError);
  });
});

describe("toEventBridgeCron", () => {
  const ok: [string, string][] = [
    ["0 2 * * 1-5", "cron(0 2 ? * 2-6 *)"], // Mon-Fri → 2-6 (SUN = 1)
    ["0 0 * * 0", "cron(0 0 ? * 1 *)"], // Sunday
    ["0 0 * * 7", "cron(0 0 ? * 1 *)"], // 7 is also Sunday
    ["*/15 * * * *", "cron(0/15 * * * ? *)"],
    ["30 4 1 * *", "cron(30 4 1 * ? *)"],
    ["0 9 * * MON-FRI", "cron(0 9 ? * 2-6 *)"],
    ["0 12 15 jan,jul *", "cron(0 12 15 1,7 ? *)"],
    ["5,35 8-17 * * *", "cron(5,35 8-17 * * ? *)"],
    ["0-30/10 * * * *", "cron(0,10,20,30 * * * ? *)"],
    ["0 0 */2 * *", "cron(0 0 1/2 * ? *)"],
    ["0 6 * * 5-7", "cron(0 6 ? * 1,6-7 *)".replace("1,6-7", "1,6,7")],
    ["0 6 * * */2", "cron(0 6 ? * 1,3,5,7 *)"],
    ["* * * * *", "cron(* * * * ? *)"],
    ["  0   1  * *  * ", "cron(0 1 * * ? *)"],
    ["@daily", "cron(0 0 * * ? *)"],
    ["@hourly", "cron(0 * * * ? *)"],
    ["@weekly", "cron(0 0 ? * 1 *)"],
    ["@monthly", "cron(0 0 1 * ? *)"],
    ["@yearly", "cron(0 0 1 1 ? *)"],
  ];
  it.each(ok)("%s → %s", (input, expected) => {
    expect(toEventBridgeCron(input).expression).toBe(expected);
  });

  it("exactly one day field is `?`, always", () => {
    for (const [input] of ok) {
      const f = toEventBridgeCron(input).expression.slice(5, -1).split(" ");
      expect(f).toHaveLength(6);
      expect([f[2], f[4]].filter((x) => x === "?")).toHaveLength(1);
    }
  });

  const rejected: [string, RegExp][] = [
    ["0 0 1 * 1", /both day-of-month and day-of-week/],
    ["0 0 1,15 * MON", /both day-of-month and day-of-week/],
    ["0 0 * *", /expected 5 fields/],
    ["0 0 * * * *", /expected 5 fields/],
    ["0 0 ? * *", /characters that are not part of 5-field cron/],
    ["0 0 L * *", /is not a number/],
    ["0 0 * * 1#2", /characters that are not part of 5-field cron/],
    ["60 * * * *", /outside 0-59/],
    ["* 24 * * *", /outside 0-23/],
    ["* * 0 * *", /outside 1-31/],
    ["* * * 13 *", /outside 1-12/],
    ["* * * * 8", /outside 0-7/],
    ["5-1 * * * *", /wraps around/],
    ["5/15 * * * *", /not Unix cron syntax/],
    ["*/0 * * * *", /invalid step/],
    ["*/2/3 * * * *", /more than one step/],
    ["1,,2 * * * *", /empty list item/],
    ["@reboot", /no scheduled equivalent/],
    ["cron(0 2 * * ? *)", /not an EventBridge expression/],
    ["rate(5 minutes)", /not an EventBridge expression/],
    ["", /1-100 characters/],
    ["0 0 * * * # comment", /characters that are not part of 5-field cron|expected 5 fields/],
    ["0 0 * * *\n; rm -rf /", /characters that are not part of 5-field cron|expected 5 fields/],
    ['0 0 * * *"', /characters that are not part of 5-field cron/],
    ["${file(\"/etc/passwd\")} * * * *", /characters that are not part of 5-field cron/],
  ];
  it.each(rejected)("rejects %j", (input, message) => {
    expect(() => toEventBridgeCron(input)).toThrow(CronError);
    expect(() => toEventBridgeCron(input)).toThrow(message);
  });

  it("rejects non-strings and absurdly long input", () => {
    expect(() => toEventBridgeCron(undefined as unknown as string)).toThrow(CronError);
    expect(() => toEventBridgeCron("1 ".repeat(80))).toThrow(CronError);
  });
});

describe("parseImageRef", () => {
  it("accepts tags, digests and registries, and rebuilds a canonical reference", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseImageRef("nginx")).toMatchObject({ repository: "nginx", ref: "nginx" });
    expect(parseImageRef("ghcr.io/acme/api:1.2.3")).toMatchObject({ host: "ghcr.io", repository: "acme/api", tag: "1.2.3" });
    expect(parseImageRef(`123456789012.dkr.ecr.eu-west-1.amazonaws.com/zn-acme-web@${digest}`)).toMatchObject({ digest, repository: "zn-acme-web" });
    expect(parseImageRef("localhost:5000/team/app:dev")).toMatchObject({ host: "localhost:5000", repository: "team/app" });
    expect(parseImageRef("library/redis:7").host).toBeUndefined();
  });

  it.each(["", " ", "nginx:${x}", "nginx latest", "Nginx", "nginx:tag\n", "a/b/../c", "-bad", "img@sha256:short", "img:" + "t".repeat(129), 'img"', "img;rm", "a".repeat(300), "$(id)", "x@y"])("rejects %j", (bad) => {
    expect(() => parseImageRef(bad)).toThrow(ImageRefError);
  });

  it("rejects non-strings", () => {
    expect(() => parseImageRef(undefined)).toThrow(ImageRefError);
    expect(() => parseImageRef({ ref: "x" })).toThrow(ImageRefError);
  });

  it("finds ECR coordinates only for real ECR hosts", () => {
    const d = `sha256:${"b".repeat(64)}`;
    expect(ecrCoordinates(parseImageRef(`123456789012.dkr.ecr.eu-west-1.amazonaws.com/acme/api@${d}`))).toEqual({ account: "123456789012", region: "eu-west-1", repository: "acme/api" });
    expect(ecrCoordinates(parseImageRef("123456789012.dkr.ecr.eu-west-1.amazonaws.com.evil.example/acme/api:1"))).toBeUndefined();
    expect(ecrCoordinates(parseImageRef("ghcr.io/acme/api:1"))).toBeUndefined();
    expect(ecrCoordinates(parseImageRef("nginx"))).toBeUndefined();
  });
});

describe("fragment rendering", () => {
  it("escapes template openers in text and interpolates only refs", () => {
    expect(escapeTemplate("a${b}c%{d}")).toBe("a$${b}c%%{d}");
    expect(render("${file(\"/etc/passwd\")}")).toBe("$${file(\"/etc/passwd\")}");
    expect(render(new TfRef("aws_x.y.arn"))).toBe("${aws_x.y.arn}");
    expect(render(cat("arn:", new TfRef("data.aws_partition.p.partition"), ":x/${y}"))).toBe("arn:${data.aws_partition.p.partition}:x/$${y}");
    // keys are escaped too
    expect(Object.keys(render({ "k${x}": 1 }) as object)).toEqual(["k$${x}"]);
    // undefined members are dropped, null kept
    expect(render({ a: undefined, b: null, c: [1, undefined] })).toEqual({ b: null, c: [1, null] });
  });

  it("an escaped value stays escaped when the result is JSON text", () => {
    const text = renderJsonText([{ value: "${var.x}", ref: new TfRef("aws_x.y.arn") }]).text;
    expect(text).toBe('[{"value":"$${var.x}","ref":"${aws_x.y.arn}"}]');
    expect(JSON.parse(text)).toHaveLength(1);
  });

  it("refuses references that are not plain traversals", () => {
    for (const bad of ["aws_x.y\n}", "${aws_x.y}", "%{if true}", "file('x')\u0000", "a;b"]) expect(() => rawRef(bad)).toThrow(/not a plain reference/);
    expect(() => renderJsonText({ r: new TfRef('split("/", aws_x.y.url)[0]') })).toThrow(/cannot be embedded in JSON text/);
  });

  it("normalizes whatever ctx.ref returns, wrapped or bare", () => {
    const fx = buildFixture();
    const wrapped = mkCompileContext(fx.byAddress, { ref: () => "${aws_vpc.main.id}" });
    const bare = mkCompileContext(fx.byAddress, { ref: () => "aws_vpc.main.id" });
    expect(refOf(wrapped, "network/main", "id").expr).toBe("aws_vpc.main.id");
    expect(refOf(bare, "network/main", "id").expr).toBe("aws_vpc.main.id");
    expect(dependsOnTarget(new TfRef("aws_lb_listener_rule.r.arn"))).toBe("aws_lb_listener_rule.r");
    expect(dependsOnTarget(new TfRef("data.aws_x.y.id"))).toBe("data.aws_x.y");
  });
});

describe("assertLeastPrivilege", () => {
  const ref = new TfRef("aws_x.y.arn");
  const base = { Effect: "Allow" as const };

  it("allows exact resources and the one documented wildcard pair", () => {
    expect(() =>
      assertLeastPrivilege(
        [
          { ...base, Action: ["ecr:GetAuthorizationToken"], Resource: ["*"], wildcard: "registry_token" },
          { ...base, Action: ["ecr:BatchGetImage"], Resource: [ref] },
          { ...base, Action: ["logs:PutLogEvents"], Resource: [cat("arn:aws:logs:r:a:log-group:", ref, ":log-stream:ecs/web/*")], wildcard: "log_stream" },
        ],
        "t"
      )
    ).not.toThrow();
  });

  it.each([
    ["a wildcard action", [{ ...base, Action: ["ecr:*"], Resource: [ref] }], /wildcard action/],
    ["a bare action star", [{ ...base, Action: ["*"], Resource: [ref] }], /wildcard action/],
    ["a bare star resource on another action", [{ ...base, Action: ["s3:GetObject"], Resource: ["*"], wildcard: "registry_token" as const }], /only allowed for ecr:GetAuthorizationToken/],
    ["a bare star resource with no declared reason", [{ ...base, Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] }], /only allowed for ecr:GetAuthorizationToken/],
    ["a bare star next to other actions", [{ ...base, Action: ["ecr:GetAuthorizationToken", "ecr:BatchGetImage"], Resource: ["*"], wildcard: "registry_token" as const }], /only allowed for ecr:GetAuthorizationToken/],
    ["an undeclared suffix wildcard", [{ ...base, Action: ["s3:GetObject"], Resource: [cat(ref, "/*")] }], /undeclared wildcard/],
    ["an interior wildcard", [{ ...base, Action: ["s3:GetObject"], Resource: [cat("arn:aws:s3:::b/*/x")], wildcard: "object_keys" as const }], /trailing suffix/],
  ])("rejects %s", (_name, statements, message) => {
    expect(() => assertLeastPrivilege(statements, "t")).toThrow(message);
  });

  it("policyJson renders a parseable policy without the internal wildcard marker", () => {
    const text = policyJson([{ ...base, Sid: "A", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"], wildcard: "registry_token" }, { ...base, Action: ["ecr:BatchGetImage", "ecr:PutImage"], Resource: [ref] }], "t").text;
    const doc = JSON.parse(text);
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement[0]).toEqual({ Sid: "A", Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" });
    expect(doc.Statement[1].Resource).toBe("${aws_x.y.arn}");
    expect(text).not.toContain("wildcard");
  });

  it("rendered JSON text is not escaped a second time when it is placed in a resource body", () => {
    const body = render({ policy: policyJson([{ ...base, Action: ["ecr:BatchGetImage"], Resource: [ref] }], "t") }) as { policy: string };
    expect(body.policy).toContain('"${aws_x.y.arn}"');
    expect(body.policy).not.toContain("$${");
  });
});
