/** Operator-owned grant lifecycle; never exposed as an MCP tool. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseGrants, type AgentGrant } from "../src/lib/agent-operations/access";

const args = process.argv.slice(2), command = args.shift(), options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]?.replace(/^--/, "");
  if (!name || !args[i + 1] || options[name] || !["file", "subject", "workspace", "projects", "environments", "apps", "scopes", "days", "token-out", "id", "issuer", "oauth-subject", "oauth-client", "output"].includes(name)) throw new Error("Use documented, unique --name value pairs.");
  options[name] = args[i + 1];
}
async function privateDirectory(path: string) {
  if (!isAbsolute(path) || process.platform === "win32") throw new Error("Use an absolute path on a POSIX control host; Windows authority ACLs are not implemented.");
  const s = await lstat(dirname(path));
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077)) throw new Error("Use an existing, owned private directory with mode 0700, outside every agent checkout.");
}
async function writeNew(path: string, bytes: string) {
  await privateDirectory(path);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function main() {
  if (command === "operator-key") {
    if (!options.output || Object.keys(options).some(k => k !== "output")) throw new Error("Usage: agent-grant.ts operator-key --output /private/operator.key");
    await writeNew(options.output, `${randomBytes(32).toString("hex")}\n`);
    console.log("Created a private operator key. Keep it under an independent control-host account; never give it to an agent or place it in plugin configuration."); return;
  }
  if (!["issue", "enroll-oauth", "revoke"].includes(command ?? "") || !options.file) throw new Error("Use issue, enroll-oauth or revoke with --file /private/grants.json. Operator keys use the separate operator-key command.");
  await privateDirectory(options.file);
  const lock = `${options.file}.lock`, temp = `${options.file}.${randomUUID()}.tmp`;
  await mkdir(lock, { mode: 0o700 });
  let tokenCreated = false, committed = false;
  try {
    let grants: AgentGrant[] = [];
    try {
      const s = await lstat(options.file);
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077) || s.size > 65536) throw new Error("Existing grant authority file is unsafe.");
      grants = parseGrants(JSON.parse(await readFile(options.file, "utf8")));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let id = options.id;
    if (command === "revoke") {
      if (!id || !grants.some(g => g.id === id)) throw new Error("No matching grant exists. Verify its identifier before revoking.");
      grants = grants.filter(g => g.id !== id);
    } else {
      const days = Number(options.days ?? 1);
      if (!Number.isInteger(days) || days < 1 || days > 30 || !options.subject || !options.workspace || !options.projects && !options.apps) throw new Error("Supply a real member, workspace, allowed project/app IDs and a lifetime of 1–30 days. Issuance never creates membership.");
      id = randomUUID();
      const grant: AgentGrant = { id, kind: command === "issue" ? "opaque" : "oauth", subject: options.subject, workspaceId: options.workspace,
        projectIds: options.projects?.split(",") ?? [], ...(options.environments ? { environmentIds: options.environments.split(",") } : {}),
        ...(options.apps ? { appIds: options.apps.split(",") } : {}), scopes: (options.scopes ?? "read").split(",") as AgentGrant["scopes"],
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + days * 86400000).toISOString() };
      let token: string | undefined;
      if (command === "issue") {
        if (!options["token-out"] || options["token-out"] === options.file) throw new Error("Supply a new private --token-out path distinct from the authority file.");
        token = `za_${randomBytes(32).toString("base64url")}`;
        grant.tokenHash = createHash("sha256").update(token).digest("hex");
      } else { grant.issuer = options.issuer; grant.oauthSubject = options["oauth-subject"]; grant.oauthClientId = options["oauth-client"]; }
      grants.push(grant); parseGrants({ version: 2, grants });
      if (token) { await writeNew(options["token-out"], `${token}\n`); tokenCreated = true; }
    }
    const text = `${JSON.stringify({ version: 2, grants }, null, 2)}\n`;
    parseGrants(JSON.parse(text)); if (Buffer.byteLength(text) > 65536) throw new Error("The bounded grant authority file is full. Revoke old grants first.");
    await writeNew(temp, text); await rename(temp, options.file); committed = true;
    const directory = await open(dirname(options.file), "r"); try { await directory.sync(); } finally { await directory.close(); }
    console.log(JSON.stringify({ grantId: id, result: command === "revoke" ? "revoked" : "issued", note: "No token value was printed. Authorization is checked again by Zenith on every request." }));
  } finally {
    await rm(temp, { force: true }); await rm(lock, { recursive: true, force: true });
    if (tokenCreated && !committed) await rm(options["token-out"], { force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Grant operation failed. Inspect private files before retrying."); process.exitCode = 1; });
