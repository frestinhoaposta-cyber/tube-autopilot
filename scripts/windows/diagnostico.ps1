. (Join-Path $PSScriptRoot '_common.ps1')

$root = Get-TubeRoot
Write-TubeStep "Raiz do projeto: $root"

try {
    $node = Get-TubeNode
    Write-TubeStep "Node.js: $node ($(& $node --version))"
} catch {
    Write-Warning $_.Exception.Message
}

$hasTasks = @(Get-TubeTaskNames | Where-Object { Test-TubeTask $_ }).Count -eq 2
$hasRunEntries = @(Get-TubeRunNames | Where-Object { Test-TubeRunEntry $_ }).Count -eq 2

$scheduler = Get-Service -Name Schedule -ErrorAction SilentlyContinue
if ($scheduler) {
    Write-TubeStep ("Agendador de Tarefas: {0}" -f $scheduler.Status)
    if ($scheduler.Status -ne 'Running' -and -not $hasRunEntries) {
        Write-Warning 'O serviço Schedule está parado; as tarefas não iniciarão no logon até ele ser iniciado.'
    }
}

if ($hasTasks -and -not $hasRunEntries) {
    Write-TubeStep 'Modo de inicialização: Agendador de Tarefas.'
} elseif ($hasRunEntries -and -not $hasTasks) {
    Write-TubeStep 'Modo de inicialização: Registro do usuário (HKCU Run).'
} elseif ($hasRunEntries -and $hasTasks) {
    Write-Warning 'Agendador e registro do usuário estão ativos ao mesmo tempo; a trava duplicada impedirá dois processos.'
} else {
    Write-Warning 'Nenhuma inicialização automática instalada. Execute instalar-inicio.cmd.'
}

$envFile = Join-Path $root '.env'
Write-TubeStep ('.env: ' + $(if (Test-Path -LiteralPath $envFile) { 'presente (conteúdo não exibido)' } else { 'AUSENTE' }))
foreach ($key in @('TOKEN_ENCRYPTION_KEY', 'SESSION_SECRET', 'PERSISTENCE_DRIVER')) {
    $pattern = '^\s*' + [regex]::Escape($key) + '\s*=.+'
    $filled = (Test-Path -LiteralPath $envFile) -and [bool](Select-String -LiteralPath $envFile -Pattern $pattern -Quiet)
    Write-TubeStep ("Config {0}: {1}" -f $key, $(if ($filled) { 'preenchida' } else { 'vazia ou ausente' }))
}

Write-TubeStep 'Modo forçado pelo supervisor: PERSISTENCE_DRIVER=local, HOST=127.0.0.1, PORT=3000.'
$dataDir = Join-Path $root 'data'
Write-TubeStep ('Pasta data: ' + $(if (Test-Path -LiteralPath $dataDir) { 'presente' } else { 'ausente (será criada pelo aplicativo)' }))

foreach ($name in Get-TubeTaskNames) {
    if (Test-TubeTask $name) {
        $task = Get-ScheduledTask -TaskName $name
        $info = Get-ScheduledTaskInfo -TaskName $name
        Write-TubeStep ("Tarefa {0}: estado={1}; último resultado={2}; última execução={3}" -f $name, $task.State, $info.LastTaskResult, $info.LastRunTime)
    } elseif (-not $hasRunEntries) {
        Write-Warning "Tarefa $name não registrada."
    }
}

foreach ($name in Get-TubeRunNames) {
    if (Test-TubeRunEntry $name) {
        Write-TubeStep "Entrada de logon ${name}: presente."
    } else {
        Write-TubeStep "Entrada de logon ${name}: ausente."
    }
}

foreach ($port in @($script:TubeLockWebPort, $script:TubeLockWorkerPort, 3000)) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        Write-TubeStep "Porta $port sem listener."
        continue
    }
    foreach ($listener in $listeners) {
        Write-TubeStep ("Porta {0} escutando em {1} (pid {2})" -f $port, $listener.LocalAddress, $listener.OwningProcess)
    }
}

$exposed = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
if ($exposed.Count -gt 0) {
    Write-Warning 'A porta 3000 parece estar exposta em uma interface externa.'
} else {
    Write-TubeStep 'Painel limitado ao loopback.'
}

try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 5
    Write-TubeStep ("/api/health: HTTP {0} {1}" -f $response.StatusCode, $response.Content)
} catch {
    Write-Warning ("/api/health indisponível: " + $_.Exception.Message)
}

foreach ($service in @('web', 'worker')) {
    $log = Join-Path $root ("logs\windows\$service.log")
    if (Test-Path -LiteralPath $log) {
        Write-TubeStep "--- $service.log (últimas 30 linhas) ---"
        Get-Content -LiteralPath $log -Tail 30
    } else {
        Write-TubeStep ("--- $service.log ainda não existe ---")
    }
}
