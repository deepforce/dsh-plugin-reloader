# dsh-restart.ps1 - run dsh web, auto-restart when plugin-reloader signals a
# dependency change (exit code 42 by default).
#
# Usage: powershell -File dsh-restart.ps1 [dsh web args...]
param(
  [int]$RestartCode = 42
)
while ($true) {
  & dsh.cmd web @args
  if ($LASTEXITCODE -ne $RestartCode) { exit $LASTEXITCODE }
  Write-Host "[plugin-reloader] dependency change detected - restarting dsh..."
}
