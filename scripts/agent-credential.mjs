#!/usr/bin/env node
/** Operator command. Never run from an MCP tool or expose this through the agent API. */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
const args = process.argv.slice(2), command = args.shift(); const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!/^--[a-z-]+$/.test(args[i] ?? '') || !args[i + 1] || options[args[i].slice(2)] !== undefined) throw new Error('Use unique --name value pairs.');
  options[args[i].slice(2)] = args[i + 1];
}
const allowed = ['file', 'id', 'subject', 'workspace', 'projects', 'environments', 'scopes', 'days', 'token-out'];
if (!['issue', 'revoke'].includes(command) || !options.file || !isAbsolute(options.file) || Object.keys(options).some(k => !allowed.includes(k))) {
  console.error('Usage: node scripts/agent-credential.mjs issue --file /private/access.credentials.json --subject USER_ID --workspace WORKSPACE_ID --projects PROJECT_ID --token-out /private/client.token [--scopes read,plan,export] [--days 1]\nRevoke: node scripts/agent-credential.mjs revoke --file /private/access.credentials.json --id CREDENTIAL_ID'); process.exit(2);
}
if (process.platform === 'win32') { console.error('This operator utility requires POSIX file permissions. Windows authority support awaits ACL verification.'); process.exit(2); }
const identifier = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const lock = `${options.file}.lock`;
let locked = false, tokenCreated = false, committed = false;
const temp = `${options.file}.${randomUUID()}.tmp`;
try {
  const directory = await lstat(dirname(options.file));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new Error('Use a private, owned directory with mode 0700.');
  await mkdir(lock, { mode: 0o700 }); locked = true;
  let state = { version: 1, credentials: [] };
  try {
    const info = await lstat(options.file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 65536) throw new Error('Existing authority file is unsafe.');
    state = JSON.parse(await readFile(options.file, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.version !== 1 || !Array.isArray(state.credentials) || state.credentials.length > 100) throw new Error('Repair the authority file before changing it.');
  let id;
  if (command === 'revoke') {
    if (!identifier(options.id) || !state.credentials.some(r => r.id === options.id)) throw new Error('No matching credential; verify its ID.');
    id = options.id; state.credentials = state.credentials.filter(r => r.id !== id);
  } else {
    const projects = (options.projects ?? '').split(','), environments = options.environments?.split(',');
    const scopes = (options.scopes ?? 'read').split(','), days = Number(options.days ?? 1);
    if (!identifier(options.subject) || ['local', 'navigator', 'system'].includes(options.subject) || !identifier(options.workspace)
      || !projects.every(identifier) || projects.length > 100 || environments && (!environments.every(identifier) || environments.length > 100)
      || !scopes.includes('read') || scopes.some(s => !['read', 'plan', 'export'].includes(s)) || scopes.length > 3
      || !Number.isInteger(days) || days < 1 || days > 30 || !options['token-out'] || !isAbsolute(options['token-out']) || options['token-out'] === options.file || state.credentials.length >= 100)
      throw new Error('Use an actual non-demo member, explicit project IDs, read/plan/export scopes, 1-30 days, and a new absolute token file.');
    const tokenDir = await lstat(dirname(options['token-out']));
    if (!tokenDir.isDirectory() || tokenDir.isSymbolicLink() || tokenDir.uid !== process.getuid() || (tokenDir.mode & 0o077)) throw new Error('Token output directory must be owned and private (0700).');
    const token = `za_${randomBytes(32).toString('base64url')}`; id = randomUUID();
    const now = Date.now();
    state.credentials.push({ id, tokenHash: createHash('sha256').update(token).digest('hex'), subject: options.subject, workspaceId: options.workspace,
      projectIds: [...new Set(projects)], ...(environments ? { environmentIds: [...new Set(environments)] } : {}), scopes: [...new Set(scopes)],
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString() });
    const output = await open(options['token-out'], 'wx', 0o600); tokenCreated = true;
    try { await output.writeFile(`${token}\n`); await output.sync(); } finally { await output.close(); }
  }
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(contents) > 65536) throw new Error('Authority file would exceed 64 KiB. Revoke unused credentials first.');
  const output = await open(temp, 'wx', 0o600);
  try { await output.writeFile(contents); await output.sync(); } finally { await output.close(); }
  await rename(temp, options.file); committed = true;
  console.log(JSON.stringify({ ok: true, operation: command, credentialId: id, tokenPrinted: false }));
} catch {
  console.error('Credential operation failed. Check private directories, IDs, file permissions, the 100-record limit, and any stale .lock directory. Never remove a lock while another operator is using it.');
  process.exitCode = 1;
} finally {
  await rm(temp, { force: true });
  if (tokenCreated && !committed) await rm(options['token-out'], { force: true });
  if (locked) await rm(lock, { recursive: true });
}
