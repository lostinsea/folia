param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('aa', 'ab')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = $PSScriptRoot
$outputName = "$Mode-01"
$logPath = Join-Path $root "$Mode-driver.log"
$executionPath = Join-Path $root "$Mode-execution.json"
$attemptPath = Join-Path $root "$Mode-attempt.json"
$resultName = if ($Mode -eq 'aa') { 'aa-calibration-results.json' } else { 'results.json' }
$resultPath = Join-Path (Join-Path $root $outputName) $resultName
foreach ($target in @($logPath, $executionPath, $attemptPath, (Join-Path $root $outputName))) {
    if (Test-Path -LiteralPath $target) { throw "Refusing another phase attempt: $target" }
}
$declaration = [IO.File]::ReadAllText((Join-Path $root 'predeclared.json')) | ConvertFrom-Json
$budgetMs = $declaration.policy.phaseDeadlineMs
if ($budgetMs -ne 5400000) { throw 'Expected the fixed new 90-minute phase budget' }
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$start = [DateTime]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($attemptPath, (([ordered]@{
    mode = $Mode
    actualStartUtc = $start.ToString('o')
    node = $node
    phaseBudgetMs = $budgetMs
} | ConvertTo-Json) + "`n"), $utf8)
$lockPath = & $node -p "require('path').join(require('os').tmpdir(), 'folia-machine-exclusive.lock')"
if ($global:LASTEXITCODE -ne 0) { throw 'Could not determine ordinary common lock path' }
$global:LASTEXITCODE = $null
$captureErrors = @()
$ErrorActionPreference = 'Continue'
& $node (Join-Path $root 'run.js') $Mode $outputName 2>&1 |
    Tee-Object -FilePath $logPath -ErrorVariable +captureErrors
$nativeExitCode = $global:LASTEXITCODE
$ErrorActionPreference = 'Stop'
$returned = [DateTime]::UtcNow
$record = [ordered]@{
    mode = $Mode
    oneProspectiveAttempt = $true
    actualStartUtc = $start.ToString('o')
    actualNativeRunnerReturnUtc = $returned.ToString('o')
    nativeRunnerExitCode = $nativeExitCode
    captureSucceeded = ($captureErrors.Count -eq 0 -and $null -ne $nativeExitCode)
    captureErrors = @($captureErrors | ForEach-Object { $_.ToString() })
    elapsedSeconds = $clock.Elapsed.TotalSeconds
    phaseWithinBudget = $false
    resultPath = $resultPath
    resultSha256 = $null
    resultStatus = $null
    complete = $false
    qualified = $false
    resultReadbackError = $null
    commonLockPresentAfterReturn = Test-Path -LiteralPath $lockPath
}
# Retain the actual native outcome even if result interpretation subsequently fails.
[IO.File]::WriteAllText($executionPath, (($record | ConvertTo-Json -Depth 6) + "`n"), $utf8)
try {
    if (Test-Path -LiteralPath $resultPath) {
        $record.resultSha256 = (Get-FileHash -LiteralPath $resultPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $result = [IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
        $record.resultStatus = $result.status
        $record.complete = $result.complete -eq $true
        $record.qualified = $result.decision.qualified -eq $true
    }
} catch {
    $record.resultReadbackError = $_.ToString()
}
$record.elapsedSeconds = $clock.Elapsed.TotalSeconds
$record.phaseWithinBudget = $clock.Elapsed.TotalMilliseconds -lt $budgetMs
[IO.File]::WriteAllText($executionPath, (($record | ConvertTo-Json -Depth 6) + "`n"), $utf8)
Write-Output ($record | ConvertTo-Json -Compress -Depth 6)
if ($null -eq $nativeExitCode) { throw 'Native runner outcome unavailable' }
if ($captureErrors.Count) { throw 'Runner output capture failed; this phase is not qualified' }
if ($record.resultReadbackError) { throw $record.resultReadbackError }
if ($clock.Elapsed.TotalMilliseconds -ge $budgetMs) {
    $record.phaseWithinBudget = $false
    $record.elapsedSeconds = $clock.Elapsed.TotalSeconds
    [IO.File]::WriteAllText($executionPath, (($record | ConvertTo-Json -Depth 6) + "`n"), $utf8)
    throw 'Fixed phase budget exceeded during native capture/admission'
}
exit $nativeExitCode
