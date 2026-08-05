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
$projectBin = Join-Path $repoRoot 'cloudflare-worker\node_modules\.bin'
$status = 'failed'
$failureClass = $null
$groupWhatIf = $false
$personalWhatIf = $false
$applyPassed = $false
$tokenCleared = $false
$childTokenInherited = $false
$failurePhase = 'initialization'
$projectCliPathConfigured = $false
$safeErrorExcerpt = $null

function ConvertTo-SafeErrorExcerpt {
    param([string]$Text)
    $safe = $Text -replace '(?i)Bearer\s+\S+', 'Bearer [REDACTED]'
    $safe = $safe -replace '(?i)(authorization|cookie|token)\s*[:=]\s*\S+', '$1=[REDACTED]'
    $safe = $safe -replace 'https?://\S+', '[URL]'
    $safe = $safe -replace '[A-Za-z]:\\[^\r\n|]+', '[PATH]'
    $safe = $safe -replace '[A-Za-z0-9_-]{30,}', '[REDACTED]'
    $safe = $safe -replace '[\x00-\x1F\x7F]+', ' '
    $safe = ($safe -replace '\s+', ' ').Trim()
    if ($safe.Length -gt 256) { $safe = $safe.Substring(0, 256) }
    return $safe
}

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
    if ($exitCode -ne 0) {
        $combined = $output -join [Environment]::NewLine
        $script:safeErrorExcerpt = ConvertTo-SafeErrorExcerpt (($output | Select-Object -Last 8) -join [Environment]::NewLine)
        if ($combined -match 'effective Cron could not be verified') { throw 'effective_cron_unverified' }
        if ($combined -match 'wrangler CLI is not available') { throw 'wrangler_cli_unavailable' }
        if ($combined -match 'gh CLI is not available') { throw 'gh_cli_unavailable' }
        if ($combined -match 'GitHub and Cloudflare destination modes differ') { throw 'destination_mode_mismatch' }
        if ($combined -match 'health') { throw 'health_gate_failed' }
        if ($combined -match 'D1') { throw 'd1_gate_failed' }
        throw 'gated_switch_failed'
    }
}

try {
    Set-Location $repoRoot
    if (-not (Test-Path -LiteralPath (Join-Path $projectBin 'wrangler.cmd'))) {
        throw 'project_wrangler_missing'
    }
    $env:Path = "$projectBin;$env:Path"
    $projectCliPathConfigured = $true
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

    & powershell.exe -NoProfile -Command "if ([string]::IsNullOrWhiteSpace(`$env:OKAZ_CF_SCHEDULES_READ_TOKEN)) { exit 7 } else { exit 0 }"
    if ($LASTEXITCODE -ne 0) { throw 'child_token_not_inherited' }
    $childTokenInherited = $true

    $failurePhase = 'group_whatif'
    Invoke-GatedSwitch -Mode group -VersionId $GroupVersionId -TargetHealth $groupHealth
    $groupWhatIf = $true
    $failurePhase = 'personal_whatif'
    Invoke-GatedSwitch -Mode personal -VersionId $PersonalVersionId -TargetHealth $personalHealth
    $personalWhatIf = $true

    if ($Apply) {
        $failurePhase = 'group_apply'
        Invoke-GatedSwitch -Mode group -VersionId $GroupVersionId -TargetHealth $groupHealth -ExecuteApply
        $applyPassed = $true
    }
    $failurePhase = $null
    $status = 'passed'
} catch {
    $failureClass = if ($_.Exception.Message -like 'INCONSISTENT_DESTINATION_STATE*') {
        'inconsistent_destination_state'
    } elseif ($_.Exception.Message -eq 'schedules_token_missing') {
        'schedules_token_missing'
    } elseif ($_.Exception.Message -eq 'child_token_not_inherited') {
        'child_token_not_inherited'
    } elseif ($_.Exception.Message -in @('effective_cron_unverified', 'destination_mode_mismatch', 'health_gate_failed', 'd1_gate_failed', 'wrangler_cli_unavailable', 'gh_cli_unavailable', 'project_wrangler_missing')) {
        $_.Exception.Message
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
        child_token_inherited = $childTokenInherited
        failure_phase = $failurePhase
        project_cli_path_configured = $projectCliPathConfigured
        safe_error_excerpt = $safeErrorExcerpt
        token_value_logged = $false
        token_cleared = $tokenCleared
        completed_at_jst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Tokyo Standard Time').ToString('yyyy-MM-ddTHH:mm:sszzz')
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    Write-Output "cutover_phase_status=$status"
    Write-Output "token_cleared=$tokenCleared"
    Write-Output "result_file=$resultPath"
}

if ($status -ne 'passed') { exit 1 }
