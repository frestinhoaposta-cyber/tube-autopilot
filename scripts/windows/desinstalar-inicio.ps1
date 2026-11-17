. (Join-Path $PSScriptRoot '_common.ps1')

foreach ($name in Get-TubeTaskNames) {
    if (Test-TubeTask $name) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-TubeStep "Tarefa $name removida."
    } else {
        Write-TubeStep "Tarefa $name não estava registrada."
    }
}

Remove-TubeRunEntries
Write-TubeStep 'Entradas de inicialização pelo registro do usuário removidas.'

Stop-TubeProcesses
Write-TubeStep 'Inicialização automática removida. Dados, vídeos, chaves, backups e logs foram preservados.'
