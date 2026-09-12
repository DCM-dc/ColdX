param(
  [string]$Workspace = $PSScriptRoot,
  [int]$Port = 3086,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$coldxEntry = Join-Path $PSScriptRoot 'bin/coldx-web.mjs'
$coldxArgs = @($coldxEntry, '--cwd', $Workspace, '--port', "$Port")
if ($NoOpen) { $coldxArgs += '--no-open' }
& node @coldxArgs
exit $LASTEXITCODE
