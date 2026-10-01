/** Credentials are bound to a server URL, stored atomically, and never echoed.
 * POSIX files are owner-only. Windows uses and verifies an owner-only NTFS ACL
 * before storing credentials; unsupported ACL filesystems fail closed. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { CliError } from "./errors";

export interface SavedConfig { version: 1; baseUrl: string; token: string }
export function configPaths(home = homedir()): { directory: string; file: string } {
  const directory = join(home, ".zenith");
  return { directory, file: join(directory, "cli.json") };
}
export function validateToken(token: string): string {
  if (!token || token.length > 8192 || /[^\x21-\x7e]/.test(token)) throw new CliError(2, "invalid_token", "Provide one nonempty credential through stdin or ZENITH_TOKEN.");
  return token;
}
export function validateUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error();
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error();
    if (/%(?:2f|5c|2e)/i.test(url.pathname)) throw new Error();
    return url.href.replace(/\/$/, "");
  } catch { throw new CliError(2, "invalid_url", "Use an HTTPS server URL (HTTP is allowed only on literal loopback), without credentials, query or fragment."); }
}

const aclScript = `
$ErrorActionPreference = 'Stop'
$p = $env:ZENITH_CLI_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:ZENITH_CLI_ACL_ACTION -eq 'secure') {
  if (Test-Path -LiteralPath $p -PathType Container) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
}
$acl = Get-Acl -LiteralPath $p
if ($acl.Owner -ne $sid.Value -and $acl.Owner -ne $sid.Translate([System.Security.Principal.NTAccount]).Value) { throw 'owner' }
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'shared' }
}
`;

async function windowsAcl(path: string, action: "secure" | "verify"): Promise<void> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", ZENITH_CLI_ACL_PATH: path, ZENITH_CLI_ACL_ACTION: action };
  for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await new Promise<void>((resolve, reject) => execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", aclScript],
    { env, windowsHide: true, timeout: 15_000, maxBuffer: 4096 }, (error) => error ? reject(new CliError(2, "unsafe_config", "Could not establish or verify an owner-only Windows config ACL.")) : resolve()));
}

async function assertPrivate(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new CliError(2, "unsafe_config", "Config must be an owner-only regular file in an owner-only directory; symlinks are refused.");
  }
  if (process.platform === "win32") await windowsAcl(path, "verify");
}

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function loadConfig(home?: string): Promise<SavedConfig | undefined> {
  const { directory, file } = configPaths(home);
  try {
    await assertPrivate(directory, true);
    await assertPrivate(file, false);
    const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 ||
          (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error();
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!value || typeof value !== "object") throw new Error();
      const config = value as Partial<SavedConfig>;
      if (config.version !== 1 || typeof config.baseUrl !== "string" || typeof config.token !== "string") throw new Error();
      return { version: 1, baseUrl: validateUrl(config.baseUrl), token: validateToken(config.token) };
    } finally { await handle.close(); }
  } catch (error) {
    if (absent(error)) return undefined;
    if (error instanceof CliError) throw error;
    throw new CliError(2, "invalid_config", "Could not read the private CLI config. Repair permissions or use logout and login again.");
  }
}

export async function saveConfig(config: SavedConfig, home?: string): Promise<void> {
  const { directory, file } = configPaths(home);
  const temporary = join(directory, `cli-${randomUUID()}.tmp`);
  let created = false;
  try {
    try { await mkdir(directory, { mode: 0o700 }); if (process.platform === "win32") await windowsAcl(directory, "secure"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertPrivate(directory, true);
    try { await assertPrivate(file, false); } catch (error) { if (!absent(error)) throw error; }
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      if (process.platform === "win32") await windowsAcl(temporary, "secure");
      else await chmod(temporary, 0o600);
      await handle.writeFile(JSON.stringify(config) + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    await assertPrivate(file, false);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(2, "config_write_failed", "Could not write the private CLI config.");
  } finally { if (created) await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function removeConfig(home?: string): Promise<void> {
  const { directory, file } = configPaths(home);
  try { await assertPrivate(directory, true); await rm(file, { force: true }); }
  catch (error) {
    if (absent(error)) return;
    if (error instanceof CliError) throw error;
    throw new CliError(2, "config_remove_failed", "Could not remove the private CLI config.");
  }
}
