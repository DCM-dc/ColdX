param([Parameter(Mandatory=$true)][string]$CancelPath)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'computer-native.cs') -ReferencedAssemblies @('System.Drawing','System.Windows.Forms','System.Web.Extensions','UIAutomationClient','UIAutomationTypes','WindowsBase')
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    if (Test-Path -LiteralPath $CancelPath) { break }
    if ($line.Length -gt 100000) { throw 'Desktop request is too large.' }
    [Console]::WriteLine([ColdXComputer.Native]::Dispatch($line, $CancelPath))
  }
} finally { [ColdXComputer.Native]::ReleaseInputs() }
