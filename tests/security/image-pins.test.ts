/**
 * Static image-pin ratchet for executable provider source and deployment files.
 * Comments, Markdown, API URLs and caller-supplied image variables are not image
 * pins. This proves checked-in references, not registry availability, arbitrary
 * runtime values, customer Dockerfile bases or live image execution.
 * Exceptions name an exact file/reference/count and fail when they go stale.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface ImageReference { file: string; ref: string }
interface Exception extends ImageReference { count: number; reason: string }
type Sources = ReadonlyMap<string, string>;
const ROOTS = ["src/lib/providers", "deploy"];
const PIN = /@sha256:[a-f0-9]{64}$/;
const REFERENCE = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?(?:@[^\s]+)?$/;
// Provider/native-resource identifiers, diagnostic codes and IAM actions are
// not container refs.
// In an explicit image field even these strings are checked as image values.
const NON_IMAGE_PREFIX = /^(?:aws|gcp|azure|oci|kubernetes|k8s|zenith|vault|arn|service|resource|scheduled_job|ecr|ecs|ec2|eks|s3|ssm|rds|rds-db|iam|logs|events|codebuild|lambda|sns|sqs|cloudfront|elasticache|secretsmanager|state|presence|last_execution|activation_policy|serverless_neg|node_pool):/;
// Exact readback diagnostics are not image values. Image fields still reject them.
const READBACK_DIAGNOSTICS = new Set(["id:not_addressable", "get:malformed", "get:denied", "get:404", "list:unavailable", "list:truncated", "list:present", "list:absent", "family:mysql_refused", "family:unregistered", "observation:simulated", "observation:absent", "observe:present", "id:absent", "work_request:none"]);
const IMAGE_FIELD = /^(?:image|imageRef|imageUri|imageName|images|[a-zA-Z_]*Image|[A-Z_]*IMAGE)$/;
const HELM = "deploy/helm/zenith-runner";

// AWS curated images are selected by name, not by a public registry digest.
// https://docs.aws.amazon.com/codebuild/latest/userguide/ec2-compute-images.html
const ALLOWLIST: readonly Exception[] = [
  { file: "src/lib/providers/aws/drivers/compute/codebuild-project.ts", ref: "aws/codebuild/standard:7.0", count: 1, reason: "AWS-managed curated CodeBuild image, selected by name; CodeBuild does not take a digest for curated images." },
  { file: `${HELM}/values.yaml`, ref: "zenith-runner:1.0.0", count: 1, reason: "unpublished; pin by digest at first release" },
  { file: "src/lib/providers/aws/drivers/compute/ecs-task.ts", ref: "${repoUrl}:zenith-bootstrap", count: 1, reason: "Deliberately nonexistent bootstrap tag; release writes a verified digest before the workload can run." },
  { file: "src/lib/providers/kubernetes/renderers/data.ts", ref: "postgres:${v}", count: 1, reason: "Existing dev-tier data renderer outside this workstream's owned paths; orchestrator follow-up to pin supported versions." },
  { file: "src/lib/providers/kubernetes/renderers/data.ts", ref: "redis:7-alpine", count: 1, reason: "Existing dev-tier data renderer outside this workstream's owned paths; orchestrator follow-up." },
  { file: "src/lib/providers/sandbox/provider.ts", ref: "postgres:16-alpine", count: 1, reason: "Legacy sandbox Compose export outside this workstream's owned paths; orchestrator follow-up." },
  { file: "src/lib/providers/sandbox/provider.ts", ref: "redis:7-alpine", count: 2, reason: "Legacy sandbox Compose export (Redis and queue) outside this workstream's owned paths; orchestrator follow-up." },
  { file: "src/lib/providers/sandbox/provider.ts", ref: "minio/minio:latest", count: 1, reason: "Legacy sandbox Compose export outside this workstream's owned paths; orchestrator follow-up to replace latest." },
  { file: "src/lib/providers/sandbox/provider.ts", ref: "axllent/mailpit:latest", count: 1, reason: "Legacy sandbox Compose export outside this workstream's owned paths; orchestrator follow-up to replace latest." },
  { file: "src/lib/providers/aws/terraform/emitters.ts", ref: "${aws_ecr_repository.${t}.repository_url}:latest", count: 1, reason: "Legacy Terraform export fallback outside this workstream's owned paths; orchestrator follow-up to require a digest." },
  { file: "src/lib/providers/azure/acr-build.ts", ref: "${input.repository}:latest", count: 1, reason: "Existing ACR build-output staging tag, not a build-tool image; outside this workstream's owned paths. Orchestrator follow-up to use an immutable operation/source tag." },
  { file: "src/lib/providers/localstack/health.ts", ref: "localstack/localstack", count: 1, reason: "Existing human-facing Docker help command; LocalStack is on hold and its files may not be edited." },
];

function sourcesOnDisk(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) sources.set(path.relative(process.cwd(), file).replaceAll("\\", "/"), fs.readFileSync(file, "utf8"));
    }
  };
  for (const root of ROOTS) walk(path.resolve(root));
  return sources;
}

function imageContext(node: ts.Node): boolean {
  let value = node;
  while (ts.isAsExpression(value.parent) || ts.isSatisfiesExpression(value.parent) || ts.isTypeAssertionExpression(value.parent) || ts.isParenthesizedExpression(value.parent)) value = value.parent;
  const parent = value.parent;
  if ((ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) && parent.initializer === value) return IMAGE_FIELD.test(parent.name.getText().replaceAll('"', "").replaceAll("'", ""));
  if (ts.isReturnStatement(parent) && parent.expression === value) {
    for (let current: ts.Node | undefined = parent.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current)) return current.name !== undefined && IMAGE_FIELD.test(current.name.text);
    }
  }
  return false;
}

function scan(sources: Sources): ImageReference[] {
  const found: ImageReference[] = [];
  for (const [file, source] of sources) {
    if (!ROOTS.some((root) => file.startsWith(`${root}/`))) continue;
    const add = (ref: string): void => { found.push({ file, ref }); };
    const candidate = (text: string, context = false): void => {
      if (!context && READBACK_DIAGNOSTICS.has(text)) return;
      const registry = /^(?:(?:[a-z0-9-]+\.)?(?:gcr|ghcr|docker|quay)\.io|[a-z0-9-]+-docker\.pkg\.dev|[a-z0-9-]+\.azurecr\.io|public\.ecr\.aws|[a-z0-9.-]+\.dkr\.ecr\.[a-z0-9.-]+\.amazonaws\.com)\//.test(text);
      const tagged = /:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(text);
      const iamAction = /^[a-z][a-z0-9-]*:[A-Z][A-Za-z0-9]*$/.test(text);
      if (REFERENCE.test(text) && !text.startsWith(".") && !/^\d+:\d+$/.test(text) && (context || registry || (text.includes("@sha") && text.includes("/")) || (tagged && !NON_IMAGE_PREFIX.test(text) && !iamAction))) add(text);
      // Static repository with a computed tag, or a computed repository with a
      // fixed latest fallback. Dynamic build-output tags are not run images.
      else if ((context && (/^[a-z0-9][a-z0-9._/-]*:\$\{[^\n]+\}$/.test(text) || (text.startsWith("${") && /:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(text)))) || (text.startsWith("${") && text.endsWith(":latest"))) add(text);
    };
    const fields = (text: string): void => {
      for (const line of text.split(/\r?\n|\\n/)) {
        const field = /(?:^\s*(?:-\s*)?|[{,]\s*)["']?(?:image|container_image|docker_image)["']?\s*[:=]\s*(.*)/.exec(line);
        if (field) {
          const value = field[1].replace(/\s+#.*$/, "").trim();
          if (value.startsWith("{{")) {
            // The chart's known helper is checked with its values below. Any
            // other template needs a renderer/explicit review, not a bypass.
            if (file !== `${HELM}/templates/deployment.yaml` || value !== '{{ include "zenith-runner.image" . | quote }}') add(value);
          } else if (/^coalesce\(/.test(value)) {
            for (const match of value.matchAll(/["']([^"']*)["']/g)) candidate(match[1], true);
          } else {
            const quoted = /^["']([^"']+)["']/.exec(value);
            if (quoted?.[1].startsWith("{{")) add(quoted[1]);
            else if (quoted) candidate(quoted[1], true);
            else if (value && !value.startsWith("${") && !value.startsWith("var.")) candidate(value, true);
          }
        }
        const from = /^\s*FROM\s+(?:--\S+\s+)*([^\s]+)(?:\s+AS\s+\S+)?\s*$/i.exec(line);
        if (from && from[1] !== "scratch") candidate(from[1], true);
      }
      // Human-facing launch instructions still contain executable image refs.
      for (const run of text.matchAll(/\b(?:docker|podman)\s+run\s+([^`\n)]+)/g)) {
        const tokens = run[1].trim().split(/\s+/);
        const withArg = new Set(["-p", "--publish", "-v", "--volume", "--mount", "-e", "--env", "--name", "--network", "--platform", "--entrypoint", "-u", "--user", "-w", "--workdir"]);
        for (let i = 0; i < tokens.length; i++) {
          if (withArg.has(tokens[i])) { i++; continue; }
          if (tokens[i].startsWith("-")) continue;
          candidate(tokens[i], true); break;
        }
      }
    };
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const constants = new Map<string, string>();
      const index = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) constants.set(node.name.text, node.initializer.text);
        ts.forEachChild(node, index);
      };
      index(parsed);
      const valueOf = (node: ts.Expression): string => {
        if (ts.isStringLiteralLike(node)) return node.text;
        if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => valueOf(span.expression) + span.literal.text).join("");
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return valueOf(node.left) + valueOf(node.right);
        if (ts.isIdentifier(node) && /_(?:IMAGE|TAG)$/.test(node.text) && constants.has(node.text)) return constants.get(node.text)!;
        return `\${${node.getText(parsed)}}`;
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        if (ts.isCallExpression(node) && ["require", "import"].includes(node.expression.getText(parsed))) return;
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === "cat" && node.arguments.length > 1 && /repo|image/i.test(node.arguments[0].getText(parsed))) {
          candidate(node.arguments.map(valueOf).join(""), true);
          // cat's suffix alone is not an image reference.
          return;
        }
        if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
          if ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node) return;
          const text = valueOf(node);
          candidate(text, imageContext(node));
          if (/\s|["']?image["']?\s*[:=]/.test(text)) fields(text);
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    } else if (/\.(?:ya?ml|json|tf|tftpl|tpl|sh)$/.test(file) || /(?:^|\/)Dockerfile(?:\.[^/]+)?$/.test(file)) {
      fields(source.split(/\r?\n/).filter((line) => !/^\s*(?:#|\/\/)/.test(line)).join("\n"));
    }
  }

  // Helm splits its image reference across values.yaml, Chart.yaml and a Go
  // template. Resolve the existing helper explicitly rather than losing it to
  // a literal-only regex. Unknown helper changes fail closed for review.
  const valuesFile = `${HELM}/values.yaml`;
  const valuesSource = sources.get(valuesFile);
  if (valuesSource !== undefined) {
    const values = load(valuesSource) as { image?: { repository?: string; tag?: string } };
    const chart = load(sources.get(`${HELM}/Chart.yaml`) ?? "") as { appVersion?: string } | undefined;
    const helper = sources.get(`${HELM}/templates/_helpers.tpl`) ?? "";
    const definition = /define "zenith-runner\.image"\s*-\}\}([\s\S]*?)\{\{- end -\}\}/.exec(helper)?.[1].replace(/\s+/g, " ").trim();
    if (definition !== '{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}') found.push({ file: valuesFile, ref: "<unreviewed zenith-runner.image helper>" });
    else found.push({ file: valuesFile, ref: `${values.image?.repository ?? "<missing repository>"}:${values.image?.tag || chart?.appVersion || "<missing tag>"}` });
  }
  return found;
}

function violations(references: readonly ImageReference[], exceptions: readonly Exception[]): string[] {
  const errors: string[] = [];
  const key = (ref: ImageReference): string => `${ref.file}: ${ref.ref}`;
  for (const ref of references) {
    if (!PIN.test(ref.ref) && !exceptions.some((entry) => key(entry) === key(ref))) errors.push(`Unpinned image ${key(ref)}`);
  }
  const keys = new Set<string>();
  for (const entry of exceptions) {
    if (keys.has(key(entry))) errors.push(`Duplicate exception ${key(entry)}`);
    keys.add(key(entry));
    const count = references.filter((ref) => !PIN.test(ref.ref) && key(ref) === key(entry)).length;
    if (count !== entry.count) errors.push(`Stale/expanded exception ${key(entry)}: expected ${entry.count}, found ${count}`);
    if (!Number.isInteger(entry.count) || entry.count < 1) errors.push(`Exception needs a positive occurrence count ${key(entry)}`);
    if (!entry.reason.trim()) errors.push(`Exception needs a reason ${key(entry)}`);
  }
  return errors;
}

const FILE = "src/lib/providers/gcp/drivers/build/probe.ts";
const fixture = (source: string, file = FILE): Map<string, string> => new Map([[file, source]]);
const digest = `sha256:${"a".repeat(64)}`;

describe("provider and deployment image pins", () => {
  it("rejects unpinned references and stale or expanded exceptions in the repository", () => {
    const references = scan(sourcesOnDisk());
    expect(references.some((ref) => ref.ref.startsWith("gcr.io/cloud-builders/docker@sha256:"))).toBe(true);
    expect(violations(references, ALLOWLIST)).toEqual([]);
  });

  it.each([...READBACK_DIAGNOSTICS])("readback diagnostic %s is excluded only outside image fields", value => {
    expect(violations(scan(fixture(`const basis = ["${value}"];`)), [])).toEqual([]);
    expect(violations(scan(fixture(`const IMAGE = "${value}";`)), [])).toHaveLength(1);
  });

  it.each([
    'export const IMAGE = "gcr.io/cloud-builders/docker";',
    'export const IMAGE = "ghcr.io/example/tool:1.2";',
    'export const IMAGE = "alpine:latest";',
    'export const IMAGE = "busybox";',
    'export const IMAGE = "busybox" as const;',
    'const IMAGE = "alpine" + ":latest";',
    'export const TOOL = "alpine:stable";',
    'const steps = [{ name: "gcr.io/cloud-builders/docker:latest" }];',
    'const IMAGE = `postgres:${version}`;',
    'const IMAGE = "registry.example:5000/tool:v1";',
    'const IMAGE = "ghcr.io/example/tool@sha256:short";',
    'const IMAGE = "ghcr.io/example/tool@sha512:1234";',
    'const IMAGE = "ghcr.io/example/tool:latest@sha256:short";',
  ])("detects an unpinned TypeScript image: %s", (source) => {
    expect(violations(scan(fixture(source)), [])).toHaveLength(1);
  });

  it.each([
    ["deploy/new/pod.yaml", "image: ghcr.io/example/tool:v1"],
    ["deploy/new/pod.yml", 'image: "alpine:latest"'],
    ["deploy/new/main.tf", 'image = "docker.io/library/node:22"'],
    ["deploy/new/task.json", '{"image": "busybox:1"}'],
    ["deploy/new/Dockerfile", "FROM --platform=linux/amd64 node:22 AS build"],
    [FILE, 'const manifest = `image: redis:7-alpine\\n`;'],
    [FILE, 'const manifest = \'{"image":"busybox:1"}\';'],
    [FILE, 'const launch = "docker run --rm -p 1234:1234 busybox:1 echo hi";'],
    ["deploy/new/pod.yaml", "image: {{ .Values.otherImage }}"],
    ["deploy/new/pod.yaml", 'image: "{{ .Values.otherImage }}"'],
  ])("detects an unpinned deployment or generated image in %s", (file, source) => {
    expect(violations(scan(fixture(source, file)), [])).toHaveLength(1);
  });

  it.each(["ghcr.io/example/tool", "docker.io/library/alpine:latest", "registry.example:5000/tool:v1"])("accepts an immutable sha256 reference for %s", (repo) => {
    expect(violations(scan(fixture(`const IMAGE = "${repo}@${digest}";`)), [])).toEqual([]);
  });

  it("ignores comments, imports, API URLs, provider types and non-image latest metadata", () => {
    const source = '// former image: alpine:latest\n/* gcr.io/cloud-builders/docker:latest */\nimport fs from "node:fs";\nconst url = "https://gcr.io/v2/tool/manifests/latest";\nconst nativeType = "aws:codebuild_project";\nconst metadata = { "pod-security.kubernetes.io/enforce-version": "latest" };';
    expect(scan(fixture(source))).toEqual([]);
    expect(scan(fixture("# image: alpine:latest\nenforce-version: latest", "deploy/new/config.yaml"))).toEqual([]);
  });

  it("scans only the two owned scan roots and executable files", () => {
    expect(scan(fixture('const IMAGE = "alpine:latest";', "tests/providers/probe.ts"))).toEqual([]);
    expect(scan(fixture("`alpine:latest`", "deploy/new/README.md"))).toEqual([]);
  });

  it("resolves the named unpublished Helm runner and notices its tag or helper changing", () => {
    const sources = new Map([
      [`${HELM}/values.yaml`, 'image:\n  repository: zenith-runner\n  tag: ""\n'],
      [`${HELM}/Chart.yaml`, 'appVersion: "1.0.0"\n'],
      [`${HELM}/templates/_helpers.tpl`, '{{- define "zenith-runner.image" -}}\n{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}\n{{- end -}}'],
    ]);
    const exception = ALLOWLIST.filter((entry) => entry.file === `${HELM}/values.yaml`);
    expect(violations(scan(sources), exception)).toEqual([]);
    sources.set(`${HELM}/Chart.yaml`, 'appVersion: "1.0.1"\n');
    expect(violations(scan(sources), exception)).toHaveLength(2);
    sources.set(`${HELM}/templates/_helpers.tpl`, '{{- define "zenith-runner.image" -}}alpine:latest{{- end -}}');
    expect(violations(scan(sources), exception)).toHaveLength(2);
  });

  it("requires an exact file/reference/count and an explanatory reason for every exception", () => {
    const references = scan(fixture('const IMAGE = "alpine:latest";'));
    const exception = { file: FILE, ref: "alpine:latest", count: 1, reason: "Fixture for the ratchet" };
    expect(violations(references, [exception])).toEqual([]);
    expect(violations([], [exception])).toHaveLength(1);
    expect(violations(scan(fixture(`const IMAGE = "alpine@${digest}";`)), [exception])).toHaveLength(1);
    expect(violations(references, [{ ...exception, file: "deploy/other.yaml" }])).toHaveLength(2);
    expect(violations(references, [{ ...exception, ref: "alpine:3" }])).toHaveLength(2);
    expect(violations([...references, ...references], [exception])).toHaveLength(1);
    expect(violations(references, [exception, exception])).toHaveLength(1);
    expect(violations(references, [{ ...exception, reason: "" }])).toHaveLength(1);
    expect(violations([], [{ ...exception, count: 0 }])).toHaveLength(1);
  });
});
