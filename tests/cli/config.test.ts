/** Login uses private on-disk fixtures. POSIX mode assertions are explicitly
 * skipped on Windows; Windows tests exercise real owner-only ACL verification. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { configPaths, loadConfig, saveConfig } from "@/cli/config";
import { TOKEN, fixture, invoke } from "./support";
import { windowsFixtureFailureMessage } from "../../scripts/ci/skipped-platforms.mjs";

let home: string;
let server: Awaited<ReturnType<typeof fixture>>;
const pendingWindowsAclStartup = new Set<string>();
beforeEach(async () => {
  const ownedHome = await mkdtemp(join(tmpdir(), "zenith-cli-config-"));
  home = ownedHome; server = await fixture();
  if (process.platform === "win32") await windowsAclPrerequisite(ownedHome);
});
afterEach(async () => {
  const ownedHome = home, ownedServer = server;
  await ownedServer.close();
  if (pendingWindowsAclStartup.has(ownedHome)) throw new Error("Windows ACL fixture prerequisite cleanup unconfirmed.");
  await rm(ownedHome, { recursive: true, force: true });
});
const environment = (url: string) => ({ ZENITH_URL: url });

async function login(input = TOKEN + "\n") {
  return invoke(server.url, ["login", "--token-stdin", "--json"], input, { home, env: environment(server.url) });
}

// Load the native ACL subsystem on this fresh home before the unchanged timed leaf.
async function windowsAclPrerequisite(directory: string) {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ZENITH_TEST_ACL_HOME: directory };
  for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const script = `$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:ZENITH_TEST_ACL_HOME
$null = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$null = $acl.Access`;
  await new Promise<void>((resolve, reject) => {
    let callbackPassed = false;
    let deadline: NodeJS.Timeout | undefined;
    const refuse = () => reject(new Error("Windows ACL fixture prerequisite failed."));
    try {
      const child = execFile(join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { env, windowsHide: true, timeout: 15_000, maxBuffer: 4096 }, error => { callbackPassed = error === null; });
      pendingWindowsAclStartup.add(directory);
      child.once("close", (code, signal) => {
        pendingWindowsAclStartup.delete(directory);
        if (deadline) clearTimeout(deadline);
        if (callbackPassed && code === 0 && signal === null) resolve(); else refuse();
      });
      deadline = setTimeout(refuse, 15_000);
    } catch { refuse(); }
  });
}

// Grant only the disposable home; the child directory/file must inherit the rule.
async function windowsFixtureCommand(executable: string, args: string[], env: NodeJS.ProcessEnv, phase: "setup" | "verification") {
  await new Promise<void>((resolve, reject) => execFile(executable, args,
    { env, windowsHide: true, timeout: 3_000, maxBuffer: 4096 },
    error => error ? reject(new Error(windowsFixtureFailureMessage(phase, error))) : resolve()));
}
const inheritedAclProof = `
$ErrorActionPreference = 'Stop'
$everyone = 'S-1-1-0'
$rights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$fixtureExit = 41
foreach ($p in @($env:ZENITH_TEST_ACL_DIRECTORY, $env:ZENITH_TEST_ACL_FILE)) {
  $acl = Get-Acl -LiteralPath $p
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $inherited = @($acl.Access | Where-Object {
    $_.IsInherited -and $_.AccessControlType -eq 'Allow' -and
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $everyone -and
    $owner -ne $everyone -and ($_.FileSystemRights -band $rights) -eq $rights
  })
  if ($inherited.Count -lt 1) { exit $fixtureExit }
  $fixtureExit = 42
}
`;

describe("private login config", () => {
  it("stores stdin atomically, uses it for auth, and logout removes it", async () => {
    const result = await login(); expect(result.code).toBe(0); expect(result.stdout + result.stderr).not.toContain(TOKEN);
    const { file, directory } = configPaths(home);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, baseUrl: server.url, token: TOKEN });
    expect((await lstat(directory)).isDirectory()).toBe(true);
    const who = await invoke(server.url, ["whoami", "--json"], "", { home, env: {} });
    expect(who.code).toBe(0); expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    const logout = await invoke(server.url, ["logout", "--json"], "", { home, env: {} });
    expect(logout.code).toBe(0); await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(logout.stdout).not.toContain(TOKEN);
    expect((await invoke(server.url, ["logout", "--json"], "", { home, env: {} })).code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("POSIX config file is 0600 and directory is 0700 (mode check skipped on Windows)", async () => {
    expect((await login()).code).toBe(0);
    const paths = configPaths(home);
    expect((await stat(paths.file)).mode & 0o777).toBe(0o600); expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === "win32")("Windows refuses inherited ACLs that grant other identities access", async () => {
    const { directory, file } = configPaths(home);
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
    await windowsFixtureCommand(join(windows, "System32", "icacls.exe"), [home, "/grant", "*S-1-1-0:(OI)(CI)(RX)"], env, "setup");
    await mkdir(directory); await writeFile(file, JSON.stringify({ version: 1, baseUrl: server.url, token: TOKEN }));
    await windowsFixtureCommand(join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", inheritedAclProof],
      { ...env, ZENITH_TEST_ACL_DIRECTORY: directory, ZENITH_TEST_ACL_FILE: file }, "verification");
    await expect(loadConfig(home)).rejects.toMatchObject({ code: "unsafe_config" });
    const result = await login(); expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("accepts CRLF stdin and can replace an existing private config", async () => {
    expect((await login(TOKEN + "\r\n")).code).toBe(0); expect((await login(TOKEN + "\n")).code).toBe(0);
    expect((await loadConfig(home))?.token).toBe(TOKEN);
  });

  it("refuses forwarding a saved credential to another server", async () => {
    expect((await login()).code).toBe(0);
    const result = await invoke(server.url, ["whoami", "--url", "http://127.0.0.1:1", "--json"], "", { home, env: {} });
    expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe("credential_url_mismatch"); expect(server.requests).toHaveLength(0);
  });

  it("environment auth overrides saved credentials and bypasses malformed config", async () => {
    const { directory, file } = configPaths(home); await mkdir(directory); await writeFile(file, "malformed");
    const result = await invoke(server.url, ["whoami", "--json"], "", { home });
    expect(result.code).toBe(0); expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each(["", TOKEN + "\nextra", TOKEN + " ", TOKEN + "\u0000", "x".repeat(8195)])("refuses invalid stdin without outputting it", async (input) => {
    const result = await login(input); expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain(TOKEN);
    await expect(stat(configPaths(home).file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires token-stdin and rejects tokens in command arguments", async () => {
    const missing = await invoke(server.url, ["login", "--json"], "", { home, env: environment(server.url) }); expect(missing.code).toBe(2);
    const argument = await invoke(server.url, ["login", "--token", TOKEN, "--json"], "", { home, env: environment(server.url) });
    expect(argument.code).toBe(2); expect(argument.stdout + argument.stderr).not.toContain(TOKEN);
  });

  it("missing auth is a local usage error without a request", async () => {
    const result = await invoke(server.url, ["whoami", "--json"], "", { home, env: environment(server.url) });
    expect(result.code).toBe(2); expect(server.requests).toHaveLength(0);
  });

  it("malformed config never exposes raw contents even in debug diagnostics", async () => {
    expect((await login()).code).toBe(0);
    await writeFile(configPaths(home).file, TOKEN);
    const result = await invoke(server.url, ["whoami", "--json", "--debug"], "", { home, env: {} });
    expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it.skipIf(process.platform === "win32")("refuses shared POSIX files and symlinked config paths", async () => {
    expect((await login()).code).toBe(0);
    const { file } = configPaths(home); await chmod(file, 0o644);
    await expect(loadConfig(home)).rejects.toMatchObject({ code: "unsafe_config" });
    await chmod(file, 0o600); await rm(file);
    const target = join(home, "other.json"); await writeFile(target, "{}", { mode: 0o600 }); await symlink(target, file);
    await expect(saveConfig({ version: 1, baseUrl: server.url, token: TOKEN }, home)).rejects.toMatchObject({ code: "unsafe_config" });
    expect(await readFile(target, "utf8")).toBe("{}");
  });

  it("aborts token stdin with exit 130 before saving", async () => {
    const controller = new AbortController();
    const pending = invoke(server.url, ["login", "--token-stdin", "--json"], "", { home, env: environment(server.url), signal: controller.signal,
      stdin: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
    controller.abort();
    expect((await pending).code).toBe(130); await expect(stat(configPaths(home).file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
