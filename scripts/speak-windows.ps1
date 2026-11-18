# macspeak on Windows: the built-in SAPI voices through System.Speech, no installs.
# Usage:
#   speak-windows.ps1 speak  <tag> <currentFile> <textFile> <voice|""> <sapiRate|"">
#   speak-windows.ps1 stop   <currentFile>
#   speak-windows.ps1 voices
#   speak-windows.ps1 mkdir  <dir>
#   speak-windows.ps1 rm     <file>
# One voice at a time across sessions: the speaker writes "pid <PID> <tag>" to the
# current file after killing whichever PowerShell speaker was named there before.

$ErrorActionPreference = 'Stop'
$mode = $args[0]

function Stop-Speaker([string]$current) {
  $old = Get-Content -Raw -LiteralPath $current -ErrorAction SilentlyContinue
  if ($old -match '^pid (\d+)') {
    $p = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
    if ($p -and $p.Id -ne $PID -and $p.ProcessName -like 'powershell*') {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

switch ($mode) {
  'speak' {
    $tag = $args[1]; $current = $args[2]; $textFile = $args[3]; $voice = $args[4]; $rate = $args[5]
    Stop-Speaker $current
    $mine = "pid $PID $tag"
    Set-Content -NoNewline -LiteralPath $current -Value $mine
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToDefaultAudioDevice()
    if ($voice) { $s.SelectVoice($voice) }
    if ($rate -match '^-?\d+$') { $s.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$rate)) }
    $text = Get-Content -Raw -LiteralPath $textFile
    # Give way if a newer speaker claimed the file while this one was starting.
    if ((Get-Content -Raw -LiteralPath $current -ErrorAction SilentlyContinue) -ne $mine) { exit 0 }
    $s.Speak($text)
    $s.Dispose()
  }
  'stop' { Stop-Speaker $args[1] }
  'voices' {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
      "$($_.VoiceInfo.Name)`t$($_.VoiceInfo.Culture.Name)"
    }
  }
  'mkdir' { New-Item -ItemType Directory -Force -Path $args[1] | Out-Null }
  'rm' { Remove-Item -Force -LiteralPath $args[1] -ErrorAction SilentlyContinue }
  default { Write-Error "unknown mode: $mode"; exit 2 }
}
