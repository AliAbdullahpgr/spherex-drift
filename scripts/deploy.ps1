param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('web', 'api')]
    [string]$App,
    [switch]$Production,
    [switch]$Dry
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$projectName = if ($App -eq 'web') { 'spherex-drift' } else { 'spherex-drift-api' }
$teamName = 'ali-abdullahs-projects-e7f90684'

# Upload the full repository: Vercel applies its configured web/api Root Directory.
# Uploading only web/ would make Vercel look for the nonexistent web/web/.
& vercel project inspect $projectName --scope $teamName --cwd $repoRoot --non-interactive
if ($LASTEXITCODE -ne 0) { throw 'Could not verify the deployment target.' }

$deployArgs = @('deploy', '--cwd', $repoRoot, '--project', $projectName, '--scope', $teamName)
if ($Production) { $deployArgs += '--prod' }
if ($Dry) { $deployArgs += '--dry' } else { $deployArgs += '--yes' }
& vercel @deployArgs
if ($LASTEXITCODE -ne 0) { throw 'Vercel deployment failed.' }
