/**
 * Static audit: every repository function that touches a tenant table scopes it
 * by `workspace_id` IN SQL (WS-SEC; architecture invariant 2, ground rule 6).
 *
 * `tests/controlplane/tenancy.test.ts` is the dynamic sweep: it runs every
 * function as workspace B against workspace A's rows. This is its independent
 * cross-check, from the other side: it reads the SOURCE of every repository
 * (`src/lib/controlplane/db/repos/*.ts`) and requires that any exported function
 * whose body mentions a tenant table also mentions `workspace_id`. A function
 * that forgets the predicate cannot hide behind a sweep that does not know it
 * exists, and a function that is deliberately unscoped must be named here with
 * the reason — so the set of cross-tenant-capable queries is a reviewed list,
 * not an accident.
 *
 * Limits (honest): this is a text check. It proves the predicate is PRESENT in
 * the function, not that it is correct (that is the sweep's job) and it cannot
 * generally see SQL built in another module. The native plan claim/dispatch
 * composer has a separate bounded AST provenance proof below; it establishes
 * literal SQL composition, not semantic authorization. Tenant tables are
 * discovered from migrations: every table that has a `workspace_id` column.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src", "lib", "controlplane", "db");
const REPOS = path.join(ROOT, "repos");

/** Tables that carry a `workspace_id` column, read from the migrations. */
function tenantTables(): string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d{4}_.*\.ts$/.test(f))) {
    const text = readFileSync(path.join(ROOT, "migrations", file), "utf8");
    for (const m of text.matchAll(/create table(?: if not exists)? platform\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/\bworkspace_id\b/i.test(m[2])) tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

interface Fn {
  file: string;
  name: string;
  body: string;
  source: string;
}

function functionsOf(file: string): Fn[] {
  const text = readFileSync(path.join(REPOS, file), "utf8");
  const starts = [...text.matchAll(/^export (?:async )?function (\w+)/gm)];
  return starts.map((m, i) => ({ file, name: m[1], body: text.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : text.length), source: text }));
}

/** The start repository composes two literal authority clauses and chooses only $12/$13 indexes. */
function isFixedStartAuthorityInterpolation(fn: Fn, expression: string, sqlPrefix: string): boolean {
  if (fn.file !== "workflow-start-intents.ts") return false;
  const index = /^(\w+)( \+ 1)?$/.exec(expression);
  if (sqlPrefix.endsWith("$") && index
    && fn.body.includes(`const ${index[1]} = source ? 13 : 12;`)) return true;
  if (!/^\w+$/.test(expression)
    || !fn.body.includes('const ' + expression + ' = `${LIVE_AUTHORITY}${source ? ` and ${MCP_DEPLOY_AUTHORITY}` : ""}`;')) return false;
  // Verify the actual local/imported fragment definitions, not just their names.
  const local = /(?:^|\n)const LIVE_AUTHORITY = `([^`]*)`;/.exec(fn.source);
  const imported = /(?:^|\n)export const MCP_DEPLOY_AUTHORITY = `([^`]*)`;/.exec(
    readFileSync(path.join(REPOS, "workflow-start-deploy-authority.ts"), "utf8"));
  return !!local && !!imported && !local[1].includes("${") && !imported[1].includes("${")
    && /import \{[^}]*\bMCP_DEPLOY_AUTHORITY\b[^}]*\} from "\.\/workflow-start-deploy-authority";/.test(fn.source);
}

/** Source proof for one internal composer; the composer and its imports are never executed. */
function isFixedPlanProductInterpolation(fn: Fn, expression: string, sqlText: string, composerSource: string): boolean {
  if (fn.file !== "plan-artifacts.ts" || !["claim", "dispatch"].includes(fn.name)
    || expression !== "planProductDispatchPredicate(productAuthority)") return false;
  const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const repo = parse(fn.file, fn.source), composer = parse("plan-artifact-product-authority.ts", composerSource);
  const walk = (node: ts.Node, predicate: (node: ts.Node) => boolean): boolean => {
    if (predicate(node)) return true;
    return ts.forEachChild(node, child => walk(child, predicate)) ?? false;
  };
  // map/join mean the standard builtins. Refuse module-local replacement or
  // an extra opaque initializer/statement; external module/runtime tampering
  // remains outside this bounded source proof.
  const schemaBindings = new Set(["Id", "Hash", "ObjectValue", "Row", "Reconstruction", "Witness"]);
  const schemaMethods = new Set(["string", "regex", "record", "unknown", "object", "passthrough", "nullable", "number", "int", "positive", "literal", "enum", "strict"]);
  const schemaInitializer = (node: ts.Expression): boolean => {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
    if (ts.isIdentifier(node)) return schemaBindings.has(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => ts.isExpression(item) && schemaInitializer(item));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(item => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && schemaInitializer(item.initializer));
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || !schemaMethods.has(node.expression.name.text) || !node.arguments.every(schemaInitializer)) return false;
    const receiver = node.expression.expression;
    return ts.isIdentifier(receiver) && (receiver.text === "z" || schemaBindings.has(receiver.text))
      || ts.isCallExpression(receiver) && schemaInitializer(receiver);
  };
  if (composer.statements.some(statement => !ts.isImportDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
    && !ts.isInterfaceDeclaration(statement) && !ts.isFunctionDeclaration(statement) && !ts.isVariableStatement(statement))) return false;
  if (composer.statements.some(statement => ts.isExpressionStatement(statement)
    || ts.isVariableStatement(statement) && (!(statement.declarationList.flags & ts.NodeFlags.Const)
      || statement.declarationList.declarations.some(item => !ts.isIdentifier(item.name) || !item.initializer
        || item.name.text !== "tableNames" && item.name.text !== "refuse"
          && (!schemaBindings.has(item.name.text) || !schemaInitializer(item.initializer))
        || item.name.text === "refuse" && !ts.isArrowFunction(item.initializer))))
    || walk(composer, node => ts.isIdentifier(node) && ["Array", "globalThis", "eval", "Function"].includes(node.text)
      || ts.isPropertyAccessExpression(node) && ["prototype", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties"].includes(node.name.text)
      || ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Reflect"
        && ["set", "deleteProperty"].includes(node.name.text))) return false;
  const imports = repo.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === "./plan-artifact-product-authority" && !node.importClause?.isTypeOnly
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(item => !item.isTypeOnly && !item.propertyName && item.name.text === "planProductDispatchPredicate"));
  const importedBindings: ts.ImportSpecifier[] = [];
  walk(repo, node => {
    if (ts.isImportSpecifier(node) && node.name.text === "planProductDispatchPredicate") importedBindings.push(node);
    return false;
  });
  if (imports.length !== 1 || importedBindings.length !== 1 || walk(repo, node => (ts.isVariableDeclaration(node) || ts.isParameter(node)
    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isBindingElement(node)) && !!node.name
    && ts.isIdentifier(node.name) && node.name.text === "planProductDispatchPredicate")) return false;
  const owning = repo.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === fn.name);
  if (owning.length !== 1 || !owning[0].body || !fn.body.trimStart().startsWith(owning[0].getText(repo))) return false;
  // Bind this call to the actual owning update, tenant parameters and JSON $8 input.
  const queryMatches: ts.CallExpression[] = [];
  walk(owning[0], node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "tx"
      || node.expression.name.text !== "query" || node.arguments.length !== 2) return false;
    const [query, params] = node.arguments;
    if (!ts.isTemplateExpression(query) || query.getText(repo) !== "`" + sqlText + "`"
      || !ts.isArrayLiteralExpression(params) || params.elements.length !== 8) return false;
    const calls = query.templateSpans.filter(span => span.expression.getText(repo) === expression);
    const head = query.head.text;
    if (calls.length !== 1 || !head.startsWith(`update platform.plan_artifact_uses set phase='${fn.name === "claim" ? "claimed" : "dispatched"}'`)
      || !head.includes(`where workspace_id=$1 and operation_id=$2 and phase='${fn.name === "claim" ? "ready" : "claimed"}'`)
      || params.elements[0].getText(repo) !== "input.custody.workspaceId"
      || params.elements[1].getText(repo) !== "input.custody.operationId"
      || params.elements[7].getText(repo) !== "JSON.stringify(productAuthority)") return false;
    const spanIndex = query.templateSpans.indexOf(calls[0]);
    const before = spanIndex === 0 ? query.head.text : query.templateSpans[spanIndex - 1].literal.text;
    if (!/\band\s*\($/.test(before) || !calls[0].literal.text.startsWith(")")) return false;
    const call = calls[0].expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "planProductDispatchPredicate"
      || call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]) || call.arguments[0].text !== "productAuthority") return false;
    queryMatches.push(node);
    return false;
  });
  if (queryMatches.length !== 1) return false;

  const tableDeclarations: ts.VariableDeclaration[] = [];
  walk(composer, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "tableNames") tableDeclarations.push(node);
    return false;
  });
  if (tableDeclarations.length !== 1) return false;
  const table = tableDeclarations[0], list = table.initializer;
  const canonicalTables = ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"];
  if (!ts.isVariableDeclarationList(table.parent) || !(table.parent.flags & ts.NodeFlags.Const)
    || table.parent.declarations.length !== 1 || !ts.isVariableStatement(table.parent.parent) || table.parent.parent.parent !== composer
    || table.parent.parent.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || !list || !ts.isAsExpression(list) || list.type.getText(composer) !== "const"
    || !ts.isArrayLiteralExpression(list.expression) || list.expression.elements.length !== canonicalTables.length
    || list.expression.elements.some((item, index) => !ts.isStringLiteral(item) || item.text !== canonicalTables[index])) return false;
  // Refuse writes, escapes/aliases or different method calls anywhere in this module.
  const tableMaps: ts.CallExpression[] = [];
  if (walk(composer, node => {
    if (!ts.isIdentifier(node) || node.text !== "tableNames") return false;
    if (node === table.name || ts.isTypeQueryNode(node.parent)) return false;
    const property = node.parent, call = property.parent;
    if (!ts.isPropertyAccessExpression(property) || property.expression !== node || !ts.isCallExpression(call) || call.expression !== property) return true;
    if (property.name.text === "map") tableMaps.push(call);
    return !["map", "some"].includes(property.name.text)
      || property.name.text === "some" && call.getText(composer) !== "tableNames.some(name => !tables[name])";
  }) || tableMaps.length !== 1) return false;

  const functions = composer.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "planProductDispatchPredicate");
  const declaration = functions[0];
  if (functions.length !== 1 || !declaration.body || declaration.parameters.length !== 1
    || declaration.parameters[0].name.getText(composer) !== "current"
    || declaration.parameters[0].type?.getText(composer) !== "PlanProductDispatchAuthority"
    || declaration.type?.kind !== ts.SyntaxKind.StringKeyword
    || !declaration.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || tableMaps[0].pos < declaration.pos || tableMaps[0].end > declaration.end) return false;
  const selectors = new Set(["current.tables.workspaces", "current.tables.projects", "current.tables.environments", "current.tables.members",
    "current.currentRequirement?.nativeCredential", "current.currentRequirement?.nativeOAuthGrant", "current.currentRequirement"]);
  const stringOnly = (node: ts.Expression, bindings: Set<string>, names = new Set<string>()): boolean => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
    if (ts.isIdentifier(node)) return bindings.has(node.text) || names.has(node.text);
    if (ts.isTemplateExpression(node)) return node.templateSpans.every(span => stringOnly(span.expression, bindings, names));
    if (ts.isConditionalExpression(node)) return selectors.has(node.condition.getText(composer))
      && stringOnly(node.whenTrue, bindings, names) && stringOnly(node.whenFalse, bindings, names);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "join"
      || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== " and ") return false;
    const collection = node.expression.expression;
    if (ts.isArrayLiteralExpression(collection)) return collection.elements.every(item => ts.isExpression(item) && stringOnly(item, bindings, names));
    if (!ts.isCallExpression(collection) || !ts.isPropertyAccessExpression(collection.expression)
      || !ts.isIdentifier(collection.expression.expression) || collection.expression.expression.text !== "tableNames"
      || collection.expression.name.text !== "map" || collection.arguments.length !== 1) return false;
    const callback = collection.arguments[0];
    return ts.isArrowFunction(callback) && !callback.modifiers && callback.parameters.length === 1
      && ts.isIdentifier(callback.parameters[0].name) && !callback.parameters[0].initializer
      && ts.isTemplateExpression(callback.body)
      && stringOnly(callback.body, new Set(), new Set([callback.parameters[0].name.text]));
  };
  const fixedBlock = (block: ts.Block, incoming: Set<string>): boolean => {
    const bindings = new Set(incoming);
    return block.statements.every(statement => {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
        return statement.declarationList.declarations.every(item => {
          if (!ts.isIdentifier(item.name) || bindings.has(item.name.text) || !item.initializer || !stringOnly(item.initializer, bindings)) return false;
          bindings.add(item.name.text);
          return true;
        });
      }
      if (ts.isReturnStatement(statement)) return !!statement.expression && stringOnly(statement.expression, bindings);
      return ts.isIfStatement(statement) && statement.expression.getText(composer) === 'current.kind === "native-absence"'
        && !statement.elseStatement && ts.isBlock(statement.thenStatement) && fixedBlock(statement.thenStatement, bindings);
    });
  };
  return fixedBlock(declaration.body, new Set()) && ts.isReturnStatement(declaration.body.statements.at(-1)!);
}

/**
 * Functions that touch a tenant table WITHOUT a workspace predicate on purpose,
 * each with the reason. Mirrors EXEMPT in tests/controlplane/tenancy.test.ts —
 * a new entry here needs a security review, not just a reason.
 */
const UNSCOPED: Record<string, string> = {
  "leases.acquire": "keyed by a globally unique scope string; a workspace-tagged scope refuses a foreign workspace",
  "leases.renew": "keyed by scope + holder + fence",
  "leases.release": "keyed by scope + holder + fence",
  "leases.current": "keyed by scope",
  "leases.assertFence": "keyed by scope + fence",
  "nonces.remember": "keyed by agent id (globally unique); never read by tenants",
  "nonces.prune": "system maintenance",
  "idempotency.prune": "system maintenance",
  "operations.markUncertainExpired": "system reconciler; every returned record carries its workspace",
  "operations.expireOverdue": "system reconciler",
  "jobs.expireStale": "system reaper",
  "runners.consumeRegistrationToken": "keyed by the token hash; the workspace comes FROM the token",
  "runners.registerRunner": "the workspace comes from the registration token, never from the caller",
  "machines.registerMachine": "the workspace comes from the registration token, never from the caller",
  "runners.findRunnerForAuth": "the one documented unscoped lookup: a signed request names only the agent id",
  "machines.findMachineForAuth": "the one documented unscoped lookup: a signed request names only the machine id",
  "operations.getForSystem": "execution worker only: a workflow carries just the operation id; every later call uses the workspace of the returned row (callers pinned below)",
};

describe("control-store repositories: workspace scoping is present in every function that touches a tenant table", () => {
  const tables = tenantTables();
  const files = readdirSync(REPOS).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const fns = files.flatMap(functionsOf);
  const touches = (fn: Fn) => tables.filter((t) => new RegExp(`platform\\.${t}\\b`).test(fn.body));
  const key = (fn: Fn) => `${fn.file.replace(/\.ts$/, "").replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())}.${fn.name}`;

  it("finds the tenant tables and the repository functions this audit is about (so it cannot pass by reading nothing)", () => {
    expect(tables.length).toBeGreaterThanOrEqual(20);
    expect(tables).toEqual(expect.arrayContaining(["operations", "approvals", "capability_grants", "events", "runners", "resources", "provider_connections", "incidents"]));
    expect(fns.length).toBeGreaterThan(80);
    expect(fns.filter((f) => touches(f).length > 0).length).toBeGreaterThan(50);
  });

  it("every function touching a tenant table names workspace_id, or is on the reviewed exemption list", () => {
    const offenders: string[] = [];
    for (const fn of fns) {
      const hit = touches(fn);
      if (hit.length === 0) continue;
      // the SQL column, not the TypeScript parameter: `workspaceId` in a signature proves nothing about the query
      if (/\bworkspace_id\b/.test(fn.body)) continue;
      if (key(fn) in UNSCOPED) continue;
      offenders.push(`${key(fn)} touches ${hit.join(", ")} but never mentions workspace_id`);
    }
    expect(offenders, "SECURITY INVARIANT (tenancy in SQL): scope these queries by workspace_id or add a reviewed entry to UNSCOPED with its reason").toEqual([]);
  });

  it("operations.getForSystem is called only by the execution worker's platform ports (never from a tenant-facing path)", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, "utf8").includes("getForSystem")) callers.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(callers.filter((f) => !f.startsWith("src/lib/controlplane/")).sort()).toEqual(["src/lib/execution/platform.ts"]);
  });

  it("every UNSCOPED entry still exists (a stale exemption would hide a future function of the same name)", () => {
    const names = new Set(fns.map(key));
    for (const entry of Object.keys(UNSCOPED)) expect(names.has(entry), `${entry} no longer exists; remove its exemption`).toBe(true);
  });

  it("SQL that carries a tenant id takes it as a bound parameter, never by string concatenation", () => {
    const start = fns.find(fn => fn.file === "workflow-start-intents.ts" && fn.name === "get")!;
    expect(isFixedStartAuthorityInterpolation(start, "currentAuthority", "where ")).toBe(true);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam", "$")).toBe(true);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam + 1", "$")).toBe(true);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam", "where tenant=")).toBe(false);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam + offset", "$")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, body: start.body.replace("source ? 13 : 12", "source ? callerValue : 12") }, "bindingParam", "$")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, body: start.body.replace("`${LIVE_AUTHORITY}${source ? ` and ${MCP_DEPLOY_AUTHORITY}` : \"\"}`", "callerValue") }, "currentAuthority", "where ")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, source: start.source.replace("const LIVE_AUTHORITY = `", "const LIVE_AUTHORITY = `${callerValue}") }, "currentAuthority", "where ")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, file: "another-repository.ts" }, "bindingParam", "$")).toBe(false);
    const composerSource = readFileSync(path.join(REPOS, "plan-artifact-product-authority.ts"), "utf8");
    const native = fns.filter(fn => fn.file === "plan-artifacts.ts" && ["claim", "dispatch"].includes(fn.name));
    expect(native.map(fn => fn.name).sort()).toEqual(["claim", "dispatch"]);
    for (const fn of native) {
      const query = [...fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)]
        .find(match => match[1].includes("${planProductDispatchPredicate(productAuthority)}"))![1];
      const expression = "planProductDispatchPredicate(productAuthority)";
      expect(isFixedPlanProductInterpolation(fn, expression, query, composerSource), fn.name).toBe(true);
      const hostileComposers: [string, string][] = [
        ["raw current value", composerSource.replace("return `${base} and ${tables}", "return `${current.witness.id} and ${tables}")],
        ["runtime call", composerSource.replace("return `${base} and ${tables}", "return `${String(current.witness.id)} and ${tables}")],
        ["dynamic identifier", composerSource.replace('${name}', '${current.witness.id}')],
        ["changed literal identifier", composerSource.replace('["workspaces", "members"', '["workspaces;drop table public.members", "members"')],
        ["dynamic list member", composerSource.replace('["workspaces", "members"', '[current.witness.id, "members"')],
        ["mutable list declaration", composerSource.replace('const tableNames =', 'let tableNames =')],
        ["list push", composerSource + '\ntableNames.push("unreviewed" as never);\n'],
        ["list index write", composerSource + '\ntableNames[0] = "unreviewed" as never;\n'],
        ["list alias escape", composerSource + '\nconst escaped = tableNames;\n'],
        ["extra map escape", composerSource + '\ntableNames.map((_, __, list) => list.reverse());\n'],
        ["mapped runtime call", composerSource.replace('${name}', '${String(name)}')],
        ["dynamic join", composerSource.replace('.join(" and ")', '.join(current.witness.id)')],
        ["selector runtime call", composerSource.replace('current.currentRequirement ? `', 'getCurrentRequirement() ? `')],
        ["OAuth selector runtime call", composerSource.replace('current.currentRequirement?.nativeOAuthGrant ? `', 'getCurrentOAuthGrant() ? `')],
        ["raw OAuth tuple interpolation", composerSource.replace("g.integration_id=$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'id'", "g.integration_id=${current.currentRequirement.nativeOAuthGrant.integration_id}")],
        ["OAuth branch runtime interpolation", composerSource.replace("g.integration_id=$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'id'", "g.integration_id=${String(current.currentRequirement.nativeOAuthGrant.integration_id)}")],
        ["composer side effect", composerSource.replace('  const base = `exists', '  execute(current);\n  const base = `exists')],
        ["prototype map replacement", composerSource + '\nArray.prototype.map = () => [callerControlledSql];\n'],
        ["prototype join replacement", composerSource + '\nObject.defineProperty(Array.prototype, "join", { value: () => callerControlledSql });\n'],
        ["prototype receiver alias", composerSource + '\nconst target = Object.getPrototypeOf([]); target.map = caller;\n'],
        ["reflect prototype replacement", composerSource + '\nReflect.set(Array.prototype, "map", caller);\n'],
        ["opaque module statement", composerSource + '\npatchStandardBuiltins();\n'],
        ["opaque module initializer", composerSource + '\nconst initialized = patchStandardBuiltins();\n'],
        ["opaque schema initializer", composerSource.replace('z.record(z.string(), z.unknown())', 'patchStandardBuiltins()')],
        ["nested prototype replacement", composerSource + '\nfunction patch() { Array.prototype.map = caller; }\n'],
        ["conditional opaque module effect", composerSource + '\nif (true) patchStandardBuiltins();\n'],
        ["class static module effect", composerSource + '\nclass Patch { static value = patchStandardBuiltins(); }\n'],
      ];
      for (const [label, source] of hostileComposers) {
        expect(source, label).not.toBe(composerSource);
        expect(isFixedPlanProductInterpolation(fn, expression, query, source), `${fn.name}: ${label}`).toBe(false);
      }
      const changedRepo = (from: string, to: string): Fn => {
        expect(fn.source).toContain(from);
        return { ...fn, source: fn.source.replaceAll(from, to), body: fn.body.replaceAll(from, to) };
      };
      expect(isFixedPlanProductInterpolation(changedRepo('from "./plan-artifact-product-authority"', 'from "./foreign-composer"'), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo('planProductDispatchPredicate, type', 'foreignPredicate as planProductDispatchPredicate, type'), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, source: fn.source + '\nimport { other as planProductDispatchPredicate } from "./foreign-composer";\n' }, expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo('let productAuthority: PlanProductDispatchAuthority;', 'const planProductDispatchPredicate = caller; let productAuthority: PlanProductDispatchAuthority;'), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, file: "foreign-repository.ts" }, expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, name: "read" }, expression, query, composerSource)).toBe(false);
      const foreignTable = query.replace("update platform.plan_artifact_uses", "update public.deployments");
      expect(isFixedPlanProductInterpolation(changedRepo(query, foreignTable), expression, foreignTable, composerSource)).toBe(false);
      const foreignScope = query.replace("where workspace_id=$1 and operation_id=$2", "where workspace_id=$9 and operation_id=$2");
      expect(isFixedPlanProductInterpolation(changedRepo(query, foreignScope), expression, foreignScope, composerSource)).toBe(false);
      const valuePosition = query.replace("and (${planProductDispatchPredicate(productAuthority)})", "and witness=${planProductDispatchPredicate(productAuthority)}");
      expect(isFixedPlanProductInterpolation(changedRepo(query, valuePosition), expression, valuePosition, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo("[input.custody.workspaceId,input.custody.operationId,attemptId", "[input.workspaceId,input.custody.operationId,attemptId"), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo("JSON.stringify(productAuthority)", "JSON.stringify(input)"), expression, query, composerSource)).toBe(false);
      const directValue = query.replace("planProductDispatchPredicate(productAuthority)", "productAuthority.witness.id");
      expect(isFixedPlanProductInterpolation(changedRepo(query, directValue), "productAuthority.witness.id", directValue, composerSource)).toBe(false);
    }
    const risky: string[] = [];
    for (const fn of fns) {
      // a template literal handed to .query() that interpolates something other than the known constants
      for (const m of fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)) {
        for (const interp of m[1].matchAll(/\$\{([^}]*)\}/g)) {
          const expr = interp[1].trim();
          if (isFixedStartAuthorityInterpolation(fn, expr, m[1].slice(0, interp.index))) continue;
          if (isFixedPlanProductInterpolation(fn, expr, m[1], composerSource)) continue;
          // A failed native proof cannot fall through to the older name-based column/index recognizers.
          if (fn.file === "plan-artifacts.ts" && ["claim", "dispatch"].includes(fn.name)
            && /\b(?:planProductDispatchPredicate|productAuthority)\b/.test(expr)) {
            risky.push(`${key(fn)}: \${${expr}}`);
            continue;
          }
          // allowed: column lists, ordering fragments built from constants, parameter indexes ($${n})
          if (/^(?:[A-Z][A-Z0-9_]*|where\.join\(.*\)|params\.length|n|\w+Columns?|columns|set\.join\(.*\)|order\w*)$/.test(expr)) continue;
          if (/^\w*[Cc]olumns?\b/.test(expr) || /^\w+\.join\(/.test(expr) || /length/.test(expr)) continue;
          risky.push(`${key(fn)}: \${${expr}}`);
        }
      }
    }
    expect(risky, "interpolating anything but a constant column list into SQL text is an injection risk: use $n parameters").toEqual([]);
  });
});
