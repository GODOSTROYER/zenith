import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=await mkdtemp(path.join(tmpdir(),'zenith-agent-reader-tests-'));
try {
 await writeFile(path.join(output,'package.json'),'{"type":"commonjs"}');
 execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),
  'src/lib/agent-access/security.ts','src/lib/agent-access/http.ts','--outDir',output,
  '--module','commonjs','--moduleResolution','node','--target','ES2022','--lib','ES2022,DOM',
  '--strict','--skipLibCheck','--types','node'],{cwd:root,stdio:'inherit'});
 execFileSync(process.execPath,['--test','tests/agent-access/reader.node.mjs'],{
  cwd:root,stdio:'inherit',env:{...process.env,ZENITH_AGENT_TEST_BUILD:output}});
} finally { await rm(output,{recursive:true,force:true}); }
