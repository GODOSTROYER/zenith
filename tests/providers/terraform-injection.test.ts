/**
 * The exporter writes a program, from a document it does not control.
 *
 * `src/lib/domain/types.ts` is the first wall: `Route.host` and
 * `Route.pathPrefix` now carry strict regexes, so a hostile route cannot be
 * saved through the API today. This file tests the second wall, which is the
 * one that has to hold when the first is not there — manifests also arrive
 * from importers, from revisions stored before that schema tightened, and
 * through the fields that are still free text (service and resource names,
 * env keys and values, health paths, schedules, image refs, externalRefs, and
 * the environment's own name, region and base domain).
 *
 * Every fixture below is therefore built as a plain object and handed
 * straight to `terraformFiles`, deliberately bypassing `Manifest.parse`, and
 * every payload is tagged with a sentinel so an assertion can say exactly
 * where a value ended up. The bar is not "the export looks fine": it is that
 * nothing a manifest carries is ever *evaluated* by Terraform — no live
 * `${…}` or `%{…}`, no user newline inside a quoted string or a comment, no
 * address that is referenced but never declared.
 */
import { describe, expect, it } from "vitest";
import { Manifest, Route, type Environment } from "@/lib/domain/types";
import type { ExportFile } from "@/lib/providers/types";
import {
  hclBody,
  hclComment,
  hclString,
  terraformFiles,
  terraformReadme,
} from "@/lib/providers/aws/terraform";

/* -------------------------------- sentinels ------------------------------- */

/** Rides inside `${…}` / `%{…}` payloads. */
const MARK = "ZZINJECTZZ";
/** Straddle a payload newline, so a split line can be detected exactly. */
const LEFT = "ZZLEFTZZ";
const RIGHT = "ZZRIGHTZZ";

/** A quote and a newline: close the string, open a fresh line of config. */
const BREAK = `${LEFT}"\n${RIGHT}`;
/** HCL interpolation — executable, not data. */
const INTERP = "${aws_iam_policy_document." + MARK + ".json}";
/** HCL directive — likewise. */
const DIRECTIVE = "%{if " + MARK + "}pwned%{endif}";

/* --------------------------------- fixtures ------------------------------- */

const hostileEnv: Environment = {
  id: "env-x",
  projectId: "proj-x",
  name: `staging${BREAK}region = "us-gov-west-1`,
  class: "staging",
  connectionId: "conn-x",
  region: `us-west-2${INTERP}`,
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: `atlas${BREAK}.zenith.test`,
  createdAt: "2026-01-01T00:00:00.000Z",
};

/**
 * A manifest no schema would accept, shaped like one an older revision could
 * still hold. `as unknown as Manifest` is the point of the exercise: this is
 * what `store.ts` hands the exporter when it reads a row written before the
 * regexes existed.
 */
function hostileManifest(): Manifest {
  return {
    version: 1,
    services: [
      {
        id: "svc-api",
        // A quote and a newline, plus a whole resource block to land.
        name: `api${BREAK}resource "aws_iam_role" "pwned" {`,
        kind: "web",
        source: { type: "image", image: `ghcr.io/acme/api:1${INTERP}` },
        size: "standard",
        replicas: 2,
        port: 3000,
        healthPath: `/healthz${BREAK}priority = 1`,
        env: [
          // Interpolation and directive in a value: the payload the finding
          // called out, because it executes with the operator's credentials.
          { key: `LOG_LEVEL_${MARK}`, value: `${INTERP} and ${DIRECTIVE}` },
          { key: "STRIPE_KEY", secretRef: `vault:stripe${BREAK}` },
        ],
        ownership: "managed",
      },
      {
        id: "svc-nightly",
        name: `nightly${BREAK}`,
        kind: "cron",
        source: { type: "image", image: "ghcr.io/acme/nightly:1" },
        size: "nano",
        replicas: 1,
        // Five whitespace-separated fields, so the arity check passes and the
        // per-field alphabet is what has to reject it.
        schedule: `0 * * * *"${LEFT}`,
        env: [],
        ownership: "managed",
      },
      {
        id: "svc-site",
        name: `site${BREAK}`,
        kind: "static",
        source: { type: "git", repo: "github.com/acme/site", ref: "main" },
        size: "nano",
        replicas: 1,
        env: [],
        ownership: "managed",
      },
    ],
    resources: [
      {
        id: "res-db",
        name: `main-db${BREAK}`,
        kind: "postgres",
        config: { version: `16${BREAK}deletion_protection = false` },
        size: "small",
        ownership: "managed",
      },
      {
        id: "res-events",
        name: `events${BREAK}`,
        kind: "queue",
        // Not a number: an unquoted attribute cannot be escaped, only replaced.
        config: { visibilityTimeout: `30${BREAK}` },
        size: "small",
        ownership: "managed",
      },
      {
        id: "res-legacy",
        name: `legacy-db${BREAK}`,
        kind: "postgres",
        config: {},
        size: "standard",
        ownership: "referenced",
        // Lands in an `imports.tf` comment, where a newline ends the comment.
        externalRef: `prod-postgres-1${LEFT}\n${RIGHT}# harmless`,
      },
    ],
    routes: [
      {
        id: "rt-app",
        // Exactly the finding: a host that predates the schema.
        host: `app.acme.com${BREAK}`,
        pathPrefix: `/api${INTERP}`,
        tls: true,
        managedDns: true,
      },
    ],
    bindings: [
      { id: "b-route", from: "rt-app", to: "svc-api", capability: "http" },
      { id: "b-sql", from: "svc-api", to: "res-db", capability: "sql" },
      { id: "b-queue", from: "svc-api", to: "res-events", capability: "queue_publish" },
      {
        id: "b-legacy",
        from: "svc-api",
        to: "res-legacy",
        capability: "sql",
        note: `reads orders${LEFT}\n${RIGHT}# and writes them`,
      },
    ],
  } as unknown as Manifest;
}

const bundle = () => terraformFiles(hostileEnv, hostileManifest());

/* ------------------------------- HCL scanning ------------------------------ */

/** Everything Terraform will actually load: the .tf files and the tfvars. */
const hcl = (files: ExportFile[]) =>
  files
    .filter((f) => f.path.endsWith(".tf") || f.path.endsWith(".tfvars.example"))
    .map((f) => f.content)
    .join("\n");

/**
 * Interpolations and directives HCL would evaluate. `$${`/`%%{` are the
 * escaped, inert forms, so they are skipped — that is the whole distinction
 * this suite exists to prove.
 */
function liveTemplates(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?<![$%])([$%])\{([^}]*)\}?/g)) out.push(`${m[1]}{${m[2]}}`);
  return out;
}

/** Addresses a generated reference is allowed to start with. */
const GENERATED = /^[$%]\{\s*(var\.|data\.|aws_|random_|each\.|dvo\.)/;

/**
 * A plain Terraform address and nothing else — no quote, no space, no call,
 * no nested brace. Manifest text does reach an address, but only as a block
 * label and only after `tf()` has reduced it to `[A-Za-z0-9_]`, so anything
 * that escaped encoding would break this shape.
 */
const PLAIN_ADDRESS = /^[$%]\{[A-Za-z_][A-Za-z0-9_.]*(?:\[[0-9]+\][A-Za-z0-9_.]*)?\}$/;

/**
 * Walk a line the way HCL's lexer would and report whether it ended still
 * inside a quoted string — which is what a smuggled newline looks like from
 * the next line's point of view. A `#` outside a string starts a comment, so
 * quotes after it are text, not delimiters.
 */
function endsInsideString(line: string): boolean {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "#") break;
    else if (c === "/" && line[i + 1] === "/") break;
  }
  return inStr;
}

/**
 * Escaped payloads are text, not references, so they are removed before the
 * declared-vs-referenced check: `$${aws_iam_policy_document.x.json}` names
 * nothing, and counting it would be reading the escaping backwards.
 */
const stripInert = (src: string) => src.replace(/[$%][$%]\{[^}]*\}/g, "");

const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

function declarations(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"/gm)) out.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/^data\s+"([^"]+)"\s+"([^"]+)"/gm)) out.add(`data.${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/^variable\s+"([^"]+)"/gm)) out.add(`var.${m[1]}`);
  return out;
}

function references(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bvar\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(`var.${m[1]}`);
  for (const m of src.matchAll(/\bdata\.((?:aws|random)_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]*)/g))
    out.add(`data.${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/(?<!\.)\b((?:aws|random)_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]*)/g))
    out.add(`${m[1]}.${m[2]}`);
  return out;
}

/** Every block label the bundle declares. */
function labels(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^(?:resource|data)\s+"[^"]+"\s+"([^"]*)"/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^(?:variable|output)\s+"([^"]*)"/gm)) out.push(m[1]);
  return out;
}

/* ------------------------------ the encoder -------------------------------- */

describe("hclBody", () => {
  it("escapes the characters that end a string or a line", () => {
    expect(hclBody('a"b')).toBe('a\\"b');
    expect(hclBody("a\\b")).toBe("a\\\\b");
    expect(hclBody("a\nb")).toBe("a\\nb");
    expect(hclBody("a\r\nb")).toBe("a\\r\\nb");
    expect(hclBody("a\tb")).toBe("a\\tb");
    expect(hclBody("a\u0007b")).toBe("a\\u0007b");
    expect(hclBody("a\u2028b")).toBe("a\\u2028b");
  });

  it("neutralises interpolation and directive openers", () => {
    expect(hclBody("${aws_x.y}")).toBe("$${aws_x.y}");
    expect(hclBody("%{if true}")).toBe("%%{if true}");
    // A bare sigil is not an opener and stays readable.
    expect(hclBody("100% sure, $5")).toBe("100% sure, $5");
  });

  it("does not re-arm an input that is already escaped", () => {
    // HCL reads `$$${` back as the literal `$${`, which is what came in.
    expect(hclBody("$${x}")).toBe("$$${x}");
    expect(hclBody("%%{x}")).toBe("%%%{x}");
  });

  it("escapes a trailing sigil, which would otherwise pair with what follows", () => {
    // Spliced as `"...${body}{...}"`, a trailing `$` would open the brace the
    // caller writes next.
    expect(hclBody("cost$")).toBe("cost\\u0024");
    expect(hclBody("rate%")).toBe("rate\\u0025");
  });

  it("renders nothing for nothing", () => {
    expect(hclString(undefined)).toBe('""');
    expect(hclString(null)).toBe('""');
    expect(hclString(0)).toBe('"0"');
  });
});

describe("hclComment", () => {
  it("keeps a comment on one line", () => {
    expect(hclComment("a\nb")).toBe("a b");
    expect(hclComment("a\r\n\r\nb")).toBe("a b");
    expect(hclComment("a\u2028b")).toBe("a b");
  });

  it("leaves characters that are inert inside a comment alone", () => {
    expect(hclComment('# ${aws_x.y} "q"')).toBe('# ${aws_x.y} "q"');
  });
});

/* --------------------------------- the walls ------------------------------- */

describe("the schema is the first wall", () => {
  it("rejects the host this suite feeds the exporter anyway", () => {
    expect(Route.safeParse({ id: "r", host: `app.acme.com${BREAK}` }).success).toBe(false);
    expect(Route.safeParse({ id: "r", host: "app.acme.com", pathPrefix: `/${INTERP}` }).success).toBe(
      false
    );
    // And the manifest as a whole, so nobody mistakes this fixture for legal input.
    expect(Manifest.safeParse(hostileManifest()).success).toBe(false);
  });
});

describe("the exporter is the second wall", () => {
  const files = bundle();
  const src = hcl(files);

  it("evaluates only plain addresses it wrote itself", () => {
    const live = liveTemplates(src);
    expect(live.length).toBeGreaterThan(10);
    for (const t of live) {
      expect(t, `not a plain address`).toMatch(PLAIN_ADDRESS);
      expect(t, `not a generated reference`).toMatch(GENERATED);
    }
  });

  it("puts no manifest payload inside anything it evaluates", () => {
    // MARK only ever occurs in payload text — unlike LEFT/RIGHT it is never
    // part of a name, so it can never legitimately appear in an address.
    expect(src).not.toMatch(new RegExp(`(?<![$%])[$%]\\{[^}]*${MARK}`));
    // It is in the bundle, though, in its escaped form, so this is not vacuous.
    expect(src).toContain("$" + INTERP); // i.e. `$${aws_iam_policy_document…}`
    expect(src).toContain("%%{if " + MARK + "}pwned%%{endif}");
  });

  it("emits no directive block at all — it never has a reason to", () => {
    expect(src).not.toMatch(/(?<!%)%\{/);
  });

  it("keeps every manifest newline inside the value it came from", () => {
    // The sentinels straddle each injected newline: if one survived, they end
    // up on different lines.
    for (const line of src.split("\n")) {
      expect(line.includes(LEFT), `LEFT without RIGHT: ${line}`).toBe(line.includes(RIGHT));
    }
    // And the payloads really did reach the bundle, so this is not vacuous.
    expect(src).toContain(LEFT);
  });

  it("never lets a string run past the end of its line", () => {
    for (const line of src.split("\n"))
      expect(endsInsideString(line), `string ran off the line: ${line}`).toBe(false);
  });

  it("declares nothing the manifest asked for", () => {
    // The payloads are all present as text; none of them is configuration.
    expect(src).not.toMatch(/^\s*resource\s+"[^"]*"\s+"pwned"/m);
    expect(src).not.toMatch(/^\s*region\s*=\s*"us-gov-west-1/m);
    expect(src).not.toMatch(/^\s*priority\s*=\s*1\s*$/m);
    expect(src).toContain("pwned"); // …but it did reach the bundle, escaped
  });

  it("declares every address it refers to", () => {
    const clean = stripComments(stripInert(src));
    const declared = declarations(clean);
    const missing = [...references(clean)].filter((r) => !declared.has(r)).sort();
    expect(missing).toEqual([]);
  });

  it("emits only identifiers that Terraform can parse as labels", () => {
    const found = labels(src);
    expect(found.length).toBeGreaterThan(10);
    for (const l of found) expect(l, `bad label: ${l}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it("emits no empty file, and no file that lost its content to escaping", () => {
    for (const f of files) expect(f.content.trim().length, f.path).toBeGreaterThan(0);
  });
});

/* ----------------------------- site by site -------------------------------- */

describe("each template that takes manifest text", () => {
  const files = bundle();
  const at = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (!f) throw new Error(`no ${path}: ${files.map((x) => x.path).join(", ")}`);
    return f.content;
  };

  it("escapes the route host and path in the listener rule", () => {
    const alb = at("alb.tf");
    expect(alb).toContain(`values = [${hclString(`app.acme.com${BREAK}`)}]`);
    // The path keeps its trailing wildcard and its `${` stays inert.
    expect(alb).toMatch(/path_pattern \{\s*\n\s*values = \["\/api\$\$\{aws_iam_policy_document/);
  });

  it("escapes the host in the certificate and the DNS record", () => {
    // `= <literal>` rather than the padded key: alignEq owns the whitespace.
    expect(at("acm.tf")).toContain(`= ${hclString(`app.acme.com${BREAK}`)}`);
    expect(at("route53.tf")).toContain(`= ${hclString(`app.acme.com${BREAK}`)}`);
  });

  it("escapes env var names and values in the container definition", () => {
    const ecs = at("ecs.tf");
    expect(ecs).toContain(`{ name = "LOG_LEVEL_${MARK}", value = ${hclString(`${INTERP} and ${DIRECTIVE}`)} }`);
    // Belt and braces: the value is present, and inert.
    expect(ecs).toContain("$${aws_iam_policy_document.ZZINJECTZZ.json}");
    expect(ecs).toContain("%%{if ZZINJECTZZ}");
  });

  it("escapes the health path", () => {
    expect(at("alb.tf")).toContain(`= ${hclString(`/healthz${BREAK}priority = 1`)}`);
  });

  it("replaces a schedule it cannot parse instead of quoting it", () => {
    const ecs = at("ecs.tf");
    // The field alphabet rejects `*"ZZLEFTZZ`, so the whole expression falls
    // back — and the raw schedule only survives inside the escaped description.
    expect(ecs).toContain(`schedule_expression = "cron(0 * * * ? *)"`);
    expect(ecs).toMatch(/description\s+= "Schedule for nightly/);
  });

  it("replaces a non-numeric value in an unquoted attribute", () => {
    expect(at("sqs.tf")).toContain("visibility_timeout_seconds = 30");
  });

  it("keeps the import block commented when externalRef carries a newline", () => {
    const imports = at("imports.tf");
    for (const line of imports.split("\n"))
      if (line.includes(LEFT) || line.includes(RIGHT))
        expect(line.trimStart().startsWith("#"), line).toBe(true);
    expect(imports).toContain(`#   id = ${hclString(`prod-postgres-1${LEFT}\n${RIGHT}# harmless`)}`);
  });

  it("escapes the environment's own name, region and base domain", () => {
    const vars = at("variables.tf");
    for (const line of vars.split("\n"))
      expect(endsInsideString(line), `string ran off the line: ${line}`).toBe(false);
    expect(vars).toContain(`= ${hclString(hostileEnv.name)}`);
    expect(vars).toContain(`= ${hclString(hostileEnv.region)}`);
  });

  it("escapes descriptions, keys and defaults in variables and secrets", () => {
    const vars = at("variables.tf");
    const secrets = at("secrets.tf");
    for (const line of [...vars.split("\n"), ...secrets.split("\n")])
      expect(endsInsideString(line), `string ran off the line: ${line}`).toBe(false);
    // The referenced-resource default came from a hostile externalRef, and the
    // secret_values map key from a hostile secretRef.
    expect(vars).toContain(`= ${hclString(`prod-postgres-1${LEFT}\n${RIGHT}# harmless`)}`);
    expect(vars).toContain(hclString(`vault:stripe${BREAK}`));
    expect(secrets).toContain(hclString(`vault:stripe${BREAK}`));
  });

  it("keeps terraform.tfvars.example loadable, comments included", () => {
    const tfvars = at("terraform.tfvars.example");
    for (const line of tfvars.split("\n")) {
      expect(endsInsideString(line), `string ran off the line: ${line}`).toBe(false);
      expect(line.includes(LEFT)).toBe(line.includes(RIGHT));
    }
    expect(liveTemplates(tfvars)).toEqual([]);
  });
});

/* ---------------------------------- readme --------------------------------- */

describe("readme", () => {
  it("flattens manifest text so a name cannot break the table out of shape", () => {
    const readme = terraformReadme(hostileEnv, hostileManifest());
    for (const line of readme.split("\n"))
      expect(line.includes(LEFT), line).toBe(line.includes(RIGHT));
    expect(readme).toContain(LEFT);
  });
});

/* ---------------------------- degenerate manifests -------------------------- */

describe("names that sanitise to nothing", () => {
  /** Every name is punctuation, so the label generator has nothing to work with. */
  function blankNames(): Manifest {
    return {
      version: 1,
      services: [
        {
          id: "svc-1",
          name: "!!!",
          kind: "worker",
          source: { type: "image", image: "alpine:3" },
          size: "nano",
          replicas: 1,
          env: [],
          ownership: "managed",
        },
      ],
      resources: [
        { id: "r-1", name: "", kind: "queue", config: {}, size: "nano", ownership: "managed" },
        { id: "r-2", name: "9lives", kind: "redis", config: {}, size: "nano", ownership: "managed" },
      ],
      routes: [],
      bindings: [{ id: "b-1", from: "svc-1", to: "r-1", capability: "queue_publish" }],
    } as unknown as Manifest;
  }

  it("never emits an empty or digit-leading identifier", () => {
    const src = hcl(terraformFiles(hostileEnv, blankNames()));
    const found = labels(src);
    expect(found.length).toBeGreaterThan(5);
    for (const l of found) expect(l, `bad label: ${l}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    // The address in a reference has to be the same one that was declared.
    const clean = stripComments(stripInert(src));
    const declared = declarations(clean);
    expect([...references(clean)].filter((r) => !declared.has(r)).sort()).toEqual([]);
  });

  it("does not throw on a size the vocabulary no longer has", () => {
    const m = blankNames();
    (m.services[0] as { size: string }).size = "enormous";
    expect(() => terraformFiles(hostileEnv, m)).not.toThrow();
  });
});
