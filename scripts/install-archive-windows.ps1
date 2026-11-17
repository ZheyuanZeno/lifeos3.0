param(
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [string]$PythonPath='E:/Codex/venvs/lifeos-archive/Scripts/pythonw.exe',
    [switch]$Remove
)
$ErrorActionPreference='Stop'
$entry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if($Remove){Remove-ItemProperty -LiteralPath $entry -Name LifeOSArchive -ErrorAction SilentlyContinue; return}
$config=(Resolve-Path -LiteralPath $ConfigPath).Path
$python=(Resolve-Path -LiteralPath $PythonPath).Path
$agent=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../lifeos/archive_agent.py')).Path
$settings=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
if(-not $settings.primary){throw 'Windows primary archive configuration is required'}
if(-not (Test-Path -LiteralPath $settings.data_dir -PathType Container)){throw 'Archive data directory does not exist'}
$command='"'+$python+'" "'+$agent+'" --config "'+$config+'"'
if(-not (Test-Path -LiteralPath $entry)){New-Item -Path $entry -Force | Out-Null}
New-ItemProperty -LiteralPath $entry -Name LifeOSArchive -Value $command -PropertyType String -Force | Out-Null
Write-Output 'LifeOS archive starts silently after this Windows user logs in. No administrator privileges required.'
