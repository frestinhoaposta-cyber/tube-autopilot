param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('web', 'worker')]
    [string]$Service
)

. (Join-Path $PSScriptRoot '_common.ps1')

$root = Get-TubeRoot
$node = Get-TubeNode
$runService = Join-Path $root 'scripts\run-service.js'

if (-not (Test-Path -LiteralPath $runService)) {
    throw 'scripts\run-service.js não encontrado.'
}

Start-Process -FilePath $node -ArgumentList ('"{0}" --service {1} --root "{2}"' -f $runService, $Service, $root) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
