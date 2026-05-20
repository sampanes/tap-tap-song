param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [Parameter(Mandatory = $true)]
  [string]$Csv,

  [Parameter(Mandatory = $true)]
  [string]$OutputDir
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "ffmpeg was not found on PATH. Install FFmpeg, then reopen PowerShell and try again."
}

$sourcePath = Resolve-Path -LiteralPath $Source
$csvPath = Resolve-Path -LiteralPath $Csv

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$rows = Get-Content -LiteralPath $csvPath |
  Where-Object { $_.Trim() -ne "" } |
  Where-Object { $_ -notmatch '^ffmpeg\s' } |
  ConvertFrom-Csv

foreach ($row in $rows) {
  if (-not $row.start -or -not $row.end -or -not $row.file) {
    continue
  }

  $outputPath = Join-Path $OutputDir $row.file
  Write-Host "Writing $outputPath"
  & ffmpeg -y -i $sourcePath -ss $row.start -to $row.end -c:a libmp3lame -q:a 2 $outputPath
}

Write-Host "Done."
