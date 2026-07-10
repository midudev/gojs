param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
$thumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT

if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  Write-Host "Windows signing is not configured; leaving $Path unsigned."
  exit 0
}

$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $signTool) {
  throw "signtool.exe was not found in the Windows SDK."
}

& $signTool.FullName sign `
  /sha1 $thumbprint `
  /fd SHA256 `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  $Path

if ($LASTEXITCODE -ne 0) {
  throw "Signing failed for $Path."
}
