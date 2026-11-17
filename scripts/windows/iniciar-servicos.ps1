. (Join-Path $PSScriptRoot '_common.ps1')

$hasTasks = @(Get-TubeTaskNames | Where-Object { Test-TubeTask $_ }).Count -eq 2
$hasRunEntries = @(Get-TubeRunNames | Where-Object { Test-TubeRunEntry $_ }).Count -eq 2

if (-not $hasTasks -and -not $hasRunEntries) {
    throw 'Nenhuma inicialização automática encontrada. Execute instalar-inicio.cmd primeiro.'
}

if ($hasTasks) {
    foreach ($name in Get-TubeTaskNames) {
        Start-ScheduledTask -TaskName $name
        Write-TubeStep "Tarefa $name iniciada (ou já estava em execução)."
    }
} else {
    Start-TubeServicesDirect
    Write-TubeStep 'Serviços iniciados pelas entradas do registro do usuário.'
}

& (Join-Path $PSScriptRoot 'diagnostico.ps1')
