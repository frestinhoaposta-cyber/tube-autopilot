. (Join-Path $PSScriptRoot '_common.ps1')

$root = Get-TubeRoot
$node = Get-TubeNode
$envFile = Join-Path $root '.env'
$runService = Join-Path $root 'scripts\run-service.js'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Crie o arquivo .env na raiz antes de instalar. Use o .env.example como modelo e mantenha a TOKEN_ENCRYPTION_KEY original.'
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\express'))) {
    throw 'Dependências ausentes. Execute npm install na raiz do projeto antes de instalar.'
}
if (-not (Test-Path -LiteralPath $runService)) {
    throw 'scripts\run-service.js não encontrado.'
}

$scheduler = Get-Service -Name Schedule -ErrorAction SilentlyContinue
$schedulerReady = [bool]$scheduler
if ($scheduler -and $scheduler.Status -ne 'Running') {
    try {
        Start-Service -Name Schedule -ErrorAction Stop
    } catch {
        $schedulerReady = $false
        Write-Warning ('Não foi possível iniciar o Agendador de Tarefas: ' + $_.Exception.Message)
    }
}
if (-not $scheduler -or $scheduler.Status -ne 'Running') {
    $schedulerReady = $false
}

Write-TubeStep "Raiz do projeto: $root"
Write-TubeStep 'Modo local: PERSISTENCE_DRIVER=local, vídeos em data\, painel em 127.0.0.1:3000.'
Write-TubeStep 'Nenhum dado, backup ou arquivo .env será alterado.'

function Install-TubeRegistryStartup {
    Set-TubeRunEntries
    Write-TubeStep 'Usando inicialização pelo registro do usuário (HKCU Run).'
    Write-TubeStep 'Entradas criadas. Iniciando os serviços agora.'
    Start-TubeServicesDirect
    & (Join-Path $PSScriptRoot 'diagnostico.ps1')
    exit 0
}

if (-not $schedulerReady) {
    Install-TubeRegistryStartup
}

Remove-TubeRunEntries

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$webAction = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" --service web --root "{1}"' -f $runService, $root) -WorkingDirectory $root
$workerAction = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" --service worker --root "{1}"' -f $runService, $root) -WorkingDirectory $root

try {
    Register-ScheduledTask -TaskName $script:TubeTaskWeb -Action $webAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Tube AutoPilot - painel web local em http://127.0.0.1:3000' -Force | Out-Null
    Register-ScheduledTask -TaskName $script:TubeTaskWorker -Action $workerAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Tube AutoPilot - worker de agendamentos com persistência local' -Force | Out-Null
} catch {
    Write-Warning ('Não foi possível registrar as tarefas: ' + $_.Exception.Message)
    Install-TubeRegistryStartup
}

Write-TubeStep 'Tarefas registradas. Iniciando os serviços agora.'
Start-ScheduledTask -TaskName $script:TubeTaskWeb
Start-ScheduledTask -TaskName $script:TubeTaskWorker
Write-TubeStep 'Instalação concluída. Execute diagnostico.cmd para conferir.'
