# Install (or with --uninstall / -Uninstall, remove) a scheduled task that runs `digister run` daily at 05:30.
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$TaskName = "Digister"
if ($args -contains "--uninstall") { $Uninstall = $true }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task $TaskName"
  exit 0
}

$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Bin = Join-Path $Repo "bin\digister.mjs"
if (-not (Test-Path $Bin)) { throw "missing $Bin" }
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { throw "node not found on PATH; install Node 22 first" }
$Node = $NodeCmd.Source

$HomeDir = if ($env:DIGISTER_HOME) { $env:DIGISTER_HOME } else { Join-Path $env:USERPROFILE ".digister" }
$LogDir = Join-Path $HomeDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir "schedule.log"

# PATH for the job: Node's folder and Ollama's folder if found.
$Extra = @((Split-Path $Node))
$OllamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if ($OllamaCmd) { $Extra += (Split-Path $OllamaCmd.Source) }
$JobPath = ($Extra -join ";")

# cmd.exe strips the outer quotes of a /c string, hence the doubled quotes.
$CmdLine = "/c `"set `"PATH=$JobPath;%PATH%`" && set `"DIGISTER_HOME=$HomeDir`" && `"$Node`" `"$Bin`" run >> `"$Log`" 2>&1`""
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $CmdLine -WorkingDirectory $Repo
$Trigger = New-ScheduledTaskTrigger -Daily -At "05:30"
$Settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Installed scheduled task $TaskName: digister run every day at 05:30 (output appended to $Log)"
