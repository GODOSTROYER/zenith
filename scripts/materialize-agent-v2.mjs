#!/usr/bin/env node
/** Idempotent integration edits; a branch-only CI job also resolves the pinned lockfile.
 * No services are exposed and no infrastructure is deployed by this script.
 */
import { readFile, writeFile } from 'node:fs/promises';
const edit = async (path, before, after) => {
  const source = await readFile(path, 'utf8');
  if (source.includes(after)) return;
  if (source.split(before).length !== 2) throw new Error(`Refusing a non-unique or changed integration anchor in ${path}`);
  await writeFile(path, source.replace(before, after));
};
await edit('src/lib/agent-access/zenith-reader.ts', 'async function call(name: string,', 'export async function readerCall(name: string,');
await edit('src/lib/agent-access/zenith-reader.ts', '\n  call,\n', '\n  call: readerCall,\n');
await edit('src/lib/agent-operations/journal.ts', '"cancel" | "publish" | "rollback_app";', '"cancel" | "approve_deployment" | "publish" | "rollback_app";');
await edit('src/lib/agent-operations/application.ts', 'type Intent, type Owner, type Preview', 'type Intent, type Preview');
await edit('src/middleware.ts', 'if (request.nextUrl.pathname === "/api/agent/v1/mcp") return NextResponse.next({ request });',
  'if (["/api/agent/v1/mcp", "/api/agent/v2/mcp", "/api/agent/v2/review", "/api/agent/v2/source", "/.well-known/oauth-protected-resource/api/agent/v2/mcp"].includes(request.nextUrl.pathname)) return NextResponse.next({ request });');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.dependencies['@modelcontextprotocol/server'] = '2.0.0';
pkg.devDependencies['@modelcontextprotocol/client'] = '2.0.0';
pkg.scripts['test:agent'] = 'vitest run tests/agent-operations';
await writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
