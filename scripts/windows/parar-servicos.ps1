. (Join-Path $PSScriptRoot '_common.ps1')

foreach ($name in Get-TubeTaskNames) {
    if (Test-TubeTask $name) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Write-TubeStep "Tarefa $name parada."
    } else {
        Write-TubeStep "Tarefa $name não estava registrada."
    }
}

Stop-TubeProcesses
Write-TubeStep 'Processos do web e do worker encerrados. As tarefas continuam registradas para o próximo logon.'
