# Emits one line per Codex job that ends (finished with a report, or exited without one).
# Jobs are listed in jobs.txt as "WS-ID|worktree-dir"; a .reported marker prevents repeats
# across monitor re-arms.
$dir = 'C:\Users\user\AppData\Local\Temp\claude\Z--Projects-Spawned-ai\5e97a1aa-a341-43fb-821c-9424d9f61a81\scratchpad\codex'
while ($true) {
  $cmds = @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | ForEach-Object { $_.CommandLine })
  foreach ($line in (Get-Content "$dir\jobs.txt" -ErrorAction SilentlyContinue)) {
    if (-not $line.Trim()) { continue }
    $ws, $wt = $line.Split('|')
    if (Test-Path "$dir\$ws.reported") { continue }
    $running = $cmds | Where-Object { $_ -and ($_.Contains("zenith-wt/$wt") -or $_.Contains("zenith-wt\$wt")) }
    if ($running) { continue }
    if ((Test-Path "$dir\$ws.final.md") -and ((Get-Item "$dir\$ws.final.md").Length -gt 0)) {
      Write-Output "DONE $ws - final report written"
    } else {
      Write-Output "EXITED $ws without a final report - check $ws.stderr.log and $ws.events.jsonl"
    }
    New-Item -ItemType File -Path "$dir\$ws.reported" -Force | Out-Null
  }
  [Console]::Out.Flush()
  Start-Sleep -Seconds 30
}
