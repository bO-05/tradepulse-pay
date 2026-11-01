param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'Use an absolute output directory.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $output.StartsWith((Join-Path $root '.system_generated') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Narration must stay in the generated workspace directory.'
}
$scenes = Get-Content -LiteralPath (Join-Path $root 'docs/submission-demo-script.json') -Raw | ConvertFrom-Json
[IO.Directory]::CreateDirectory($output) | Out-Null
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.SelectVoice('Microsoft Zira Desktop')
  $voice.Rate = 0
  foreach ($scene in $scenes) {
    $destination = Join-Path $output ($scene.scene + '.wav')
    if (Test-Path -LiteralPath $destination) { throw 'Refusing to overwrite existing narration.' }
    $voice.SetOutputToWaveFile($destination)
    $voice.Speak([string]$scene.narration)
    $voice.SetOutputToNull()
  }
} finally { $voice.Dispose() }
Write-Output ('Offline narration created: ' + $output)
