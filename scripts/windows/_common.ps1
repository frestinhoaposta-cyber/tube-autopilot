$ErrorActionPreference = 'Stop'

$script:TubeTaskWeb = 'TubeAutoPilot-Web'
$script:TubeTaskWorker = 'TubeAutoPilot-Worker'
$script:TubeRunWeb = 'TubeAutoPilot-Web'
$script:TubeRunWorker = 'TubeAutoPilot-Worker'
$script:TubeRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:TubeLockWebPort = 43110
$script:TubeLockWorkerPort = 43111

function Get-TubeRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Get-TubeNode {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) {
        throw 'Node.js não encontrado no PATH. Instale o Node.js 22 ou superior.'
    }
    $versionText = & $command.Source --version
    $major = [int](($versionText -replace '^v', '').Split('.')[0])
    if ($major -lt 22) {
        throw "Node.js $versionText detectado. É necessário Node.js 22 ou superior."
    }
    return $command.Source
}

function Get-TubeTaskNames {
    return @($script:TubeTaskWeb, $script:TubeTaskWorker)
}

function Test-TubeTask {
    param([string]$Name)
    return [bool](Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
}

function Get-TubeRunNames {
    return @($script:TubeRunWeb, $script:TubeRunWorker)
}

function Test-TubeRunEntry {
    param([string]$Name)
    return [bool](Get-ItemProperty -Path $script:TubeRunKey -Name $Name -ErrorAction SilentlyContinue)
}

function Get-TubeLogonCommand {
    param([string]$Service)
    $logon = Join-Path $PSScriptRoot 'iniciar-logon.ps1'
    return ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Service {1}' -f $logon, $Service)
}

function Set-TubeRunEntries {
    if (-not (Test-Path -LiteralPath $script:TubeRunKey)) {
        New-Item -Path $script:TubeRunKey -Force | Out-Null
    }
    New-ItemProperty -Path $script:TubeRunKey -Name $script:TubeRunWeb -Value (Get-TubeLogonCommand -Service 'web') -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $script:TubeRunKey -Name $script:TubeRunWorker -Value (Get-TubeLogonCommand -Service 'worker') -PropertyType String -Force | Out-Null
}

function Remove-TubeRunEntries {
    foreach ($name in Get-TubeRunNames) {
        Remove-ItemProperty -Path $script:TubeRunKey -Name $name -ErrorAction SilentlyContinue
    }
}

function Start-TubeServicesDirect {
    $logon = Join-Path $PSScriptRoot 'iniciar-logon.ps1'
    & $logon -Service 'web'
    & $logon -Service 'worker'
}

function Stop-TubeProcesses {
    $root = Get-TubeRoot
    $patterns = @(
        "*$root*scripts\run-service.js*",
        "*$root*server\server.js*",
        "*$root*server\local-worker.js*"
    )
    Get-CimInstance Win32_Process | Where-Object {
        $line = $_.CommandLine
        $line -and (($patterns | Where-Object { $line -like $_ }).Count -gt 0)
    } | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
    }
}

function Write-TubeStep {
    param([string]$Message)
    Write-Host "[Tube AutoPilot] $Message"
}
