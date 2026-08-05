param(
    [switch]$Apply,

    [string]$GroupVersionId = 'e65c222d-49ba-4dff-95f4-a3059d26db32',

    [string]$PersonalVersionId = '0a685610-dbbc-40b4-bd6e-76d84051598d',

    [string]$ApprovalRecord = 'docs/status/2026-08-05_group-candidate-deploy-approval.md'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$switchScript = Join-Path $PSScriptRoot 'set-line-destination.ps1'
$resultPath = Join-Path ([IO.Path]::GetTempPath()) 'okaz-line-cutover-result.json'
$productionHealth = 'https://okaz-slot-watcher-cf.u3comp.workers.dev/health'
$groupHealth = "https://$GroupVersionId-okaz-slot-watcher-cf.u3comp.workers.dev/health"
$personalHealth = "https://$PersonalVersionId-okaz-slot-watcher-cf.u3comp.workers.dev/health"
$tokenName = 'OKAZ_CF_SCHEDULES_READ_TOKEN'
$status = 'failed'
$failureClass = $null
$groupWhatIf = $false
$personalWhatIf = $false
$applyPassed = $false
$tokenCleared = $false

function Invoke-GatedSwitch {
    param(
        [ValidateSet('personal', 'group')]
        [string]$Mode,
        [string]$VersionId,
        [string]$TargetHealth,
        [switch]$ExecuteApply
    )

    $commandArgs = @(
        '-NoProfile', '-File', $switchScript,
        '-Mode', $Mode,
        '-ExpectedGroupConfigured', 'true',
        '-CloudflareVersionId', $VersionId,
        '-CurrentHealthUrl', $productionHealth,
        '-TargetHealthUrl', $TargetHealth
    )
    if ($ExecuteApply) {
        $commandArgs += @('-Apply', '-ApprovalRecord', $ApprovalRecord)
    } else {
        $commandArgs += '-WhatIf'
    }

    $output = @(& powershell.exe @commandArgs 2>&1)
    $exitCode = $LASTEXITCODE
    $safeLines = @($output | ForEach-Object { [string]$_ } | Where-Object {
        $_ -match '^(preflight|active_version|active_percentage|current_mode|target_version|health_probe|current_health_probe|target_health_probe|github_user_verified|effective_cron_probe|schedule_count|d1_state_valid|secrets_read|whatif|apply)='
    })
    $safeLines | Write-Output
    if ($exitCode -ne 0) { throw 'gated_switch_failed' }
}

try {
    Set-Location $repoRoot
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($tokenName, 'Process'))) {
        $secureToken = Read-Host 'Cloudflare schedules read Tokenを貼り付けてEnter' -AsSecureString
        $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        try {
            $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
            [Environment]::SetEnvironmentVariable($tokenName, $plainToken, 'Process')
            $plainToken = $null
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
            $secureToken = $null
        }
    }
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($tokenName, 'Process'))) {
        throw 'schedules_token_missing'
    }

    Invoke-GatedSwitch -Mode group -VersionId $GroupVersionId -TargetHealth $groupHealth
    $groupWhatIf = $true
    Invoke-GatedSwitch -Mode personal -VersionId $PersonalVersionId -TargetHealth $personalHealth
    $personalWhatIf = $true

    if ($Apply) {
        Invoke-GatedSwitch -Mode group -VersionId $GroupVersionId -TargetHealth $groupHealth -ExecuteApply
        $applyPassed = $true
    }
    $status = 'passed'
} catch {
    $failureClass = if ($_.Exception.Message -like 'INCONSISTENT_DESTINATION_STATE*') {
        'inconsistent_destination_state'
    } elseif ($_.Exception.Message -eq 'schedules_token_missing') {
        'schedules_token_missing'
    } else {
        'gated_switch_failed'
    }
} finally {
    [Environment]::SetEnvironmentVariable($tokenName, $null, 'Process')
    $tokenCleared = [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($tokenName, 'Process'))
    [pscustomobject]@{
        status = $status
        failure_class = $failureClass
        group_whatif = $groupWhatIf
        personal_whatif = $personalWhatIf
        apply = $applyPassed
        token_value_logged = $false
        token_cleared = $tokenCleared
        completed_at_jst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Tokyo Standard Time').ToString('yyyy-MM-ddTHH:mm:sszzz')
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    Write-Output "cutover_phase_status=$status"
    Write-Output "token_cleared=$tokenCleared"
    Write-Output "result_file=$resultPath"
}

if ($status -ne 'passed') { exit 1 }
