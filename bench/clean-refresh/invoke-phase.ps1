param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('aa', 'ab')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$recordPath = Join-Path $PSScriptRoot "$Mode-caller.json"
$attemptPath = Join-Path $PSScriptRoot "$Mode-caller-attempt.json"
foreach ($target in @($recordPath, $attemptPath)) {
    if (Test-Path -LiteralPath $target) { throw "Refusing reused caller acknowledgment: $target" }
}
$budget = ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'predeclared.json')) | ConvertFrom-Json).policy.phaseDeadlineMs
if ($budget -ne 5400000) { throw 'Expected the fixed new phase budget' }
$utf8 = [Text.UTF8Encoding]::new($false)
$start = [DateTime]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
[IO.File]::WriteAllText($attemptPath, ($start.ToString('o') + "`n"), $utf8)
$global:LASTEXITCODE = $null
& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'execute-phase.ps1') -Mode $Mode
$wrapperExit = $global:LASTEXITCODE
$executionPath = Join-Path $PSScriptRoot "$Mode-execution.json"
$record = [ordered]@{
    mode = $Mode
    startUtc = $start.ToString('o')
    observedWrapperReturnUtc = [DateTime]::UtcNow.ToString('o')
    phaseWrapperExitCode = $wrapperExit
    elapsedSeconds = $clock.Elapsed.TotalSeconds
    phaseWithinBudget = $clock.Elapsed.TotalMilliseconds -lt $budget
    executionSha256 = if (Test-Path -LiteralPath $executionPath) {
        (Get-FileHash -LiteralPath $executionPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { $null }
}
[IO.File]::WriteAllText($recordPath, (($record | ConvertTo-Json) + "`n"), $utf8)
if ($clock.Elapsed.TotalMilliseconds -ge $budget) {
    $record.phaseWithinBudget = $false
    $record.elapsedSeconds = $clock.Elapsed.TotalSeconds
    [IO.File]::WriteAllText($recordPath, (($record | ConvertTo-Json) + "`n"), $utf8)
    throw 'Phase caller return/admission exceeded the fixed budget'
}
if ($null -eq $wrapperExit) { throw 'Actual phase-wrapper native return unavailable' }
exit $wrapperExit
