$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'set-line-destination.ps1'
. $scriptPath -Mode personal -LibraryOnly

$cronMode = 'ok'
$d1Mode = 'ok'
$userMode = 'ok'
$writeMode = 'ok'
$healthMode = 'personal-ok'
$writeCount = 0

function ReadOnlyFixture {
    param([string]$File, [string[]]$Arguments)
    if ($File -eq 'git' -and $Arguments -contains 'rev-parse') { return (Get-Location).Path }
    if ($File -eq 'git' -and $Arguments -contains 'get-url') { return 'https://github.com/u3comp/okaz-slot-watcher.git' }
    if ($File -eq 'gh' -and $Arguments -contains 'auth') { return 'authenticated' }
    if ($File -eq 'gh' -and $Arguments -contains 'user') { return $(if ($userMode -eq 'wrong') { 'other-user' } else { 'u3comp' }) }
    if ($File -eq 'gh' -and $Arguments -contains 'variable') { return '[]' }
    if ($File -eq 'wrangler' -and $Arguments -contains 'whoami') { return '180e8e731977b6770c393cd5c17cab91' }
    if ($File -eq 'wrangler' -and $Arguments -contains 'deployments') { return '{"id":"11111111-1111-4111-8111-111111111111","versions":[{"version_id":"22222222-2222-4222-8222-222222222222","percentage":100}]}' }
    if ($File -eq 'wrangler' -and $Arguments -contains 'versions') { return '{"id":"22222222-2222-4222-8222-222222222222","resources":{"script":{"handlers":["scheduled","fetch"]},"script_runtime":{"compatibility_date":"2026-08-02"},"bindings":[{"name":"DB","type":"d1","database_id":"04c229e8-a76b-40a8-a4b4-17c78bdcf6ff"}]}}' }
    if ($File -eq 'wrangler' -and $Arguments -contains 'schedules') { return $(if ($cronMode -eq 'mismatch') { '[{"cron":"*/5 * * * *"}]' } else { '[{"cron":"* * * * *"}]' }) }
    if ($File -eq 'wrangler' -and $Arguments -contains 'd1') {
        if ($d1Mode -eq 'pending') { return '[{"results":[{"version":1,"pending_count":1,"failures":0,"active_lease_count":0}]}]' }
        if ($d1Mode -eq 'failure') { return '[{"results":[{"version":1,"pending_count":0,"failures":1,"active_lease_count":0}]}]' }
        if ($d1Mode -eq 'lease') { return '[{"results":[{"version":1,"pending_count":0,"failures":0,"active_lease_count":1}]}]' }
        return '[{"results":[{"version":1,"pending_count":0,"failures":0,"active_lease_count":0}]}]'
    }
    throw "unexpected fixture read: $File $($Arguments -join ' ')"
}

function WriteFixture {
    param([string]$File, [string[]]$Arguments)
    $script:writeCount++
    if ($writeMode -eq 'failure') { return 1 }
    return 0
}

function HealthFixture {
    param([string]$Url)
    $body = switch ($healthMode) {
        'group-ok' { [pscustomobject]@{ line_destination_mode = 'group'; line_user_id_configured = $true; line_group_id_configured = $true } }
        'group-missing' { [pscustomobject]@{ line_destination_mode = 'group'; line_user_id_configured = $true; line_group_id_configured = $false } }
        'user-missing' { [pscustomobject]@{ line_destination_mode = 'personal'; line_user_id_configured = $false; line_group_id_configured = $false } }
        'mode-mismatch' { [pscustomobject]@{ line_destination_mode = 'group'; line_user_id_configured = $true; line_group_id_configured = $true } }
        'id-key' { [pscustomobject]@{ line_destination_mode = 'personal'; line_user_id_configured = $true; line_group_id_configured = $false; line_group_id = 'fixture-not-a-real-id' } }
        'unknown-key' { [pscustomobject]@{ line_destination_mode = 'personal'; line_user_id_configured = $true; line_group_id_configured = $false; extra = $true } }
        default { [pscustomobject]@{ line_destination_mode = 'personal'; line_user_id_configured = $true; line_group_id_configured = $false } }
    }
    return [pscustomobject]@{ StatusCode = $(if ($healthMode -eq 'http-failure') { 503 } else { 200 }); Body = $body }
}

$ReadOnlyAdapter = ${function:ReadOnlyFixture}
$WriteAdapter = ${function:WriteFixture}
$HealthAdapter = ${function:HealthFixture}
$HealthUrl = 'https://health.invalid/health'
$ExpectedGroupConfigured = 'false'

function AssertThrows([scriptblock]$Action, [string]$Label) {
    try { & $Action; throw "expected failure: $Label" } catch { if ($_.Exception.Message -like "expected failure:*") { throw } }
}

$cron = Get-EffectiveCron
if (-not $cron.Available -or $cron.Crons.Count -ne 1 -or $cron.Crons[0] -ne '* * * * *') { throw 'cron fixture failed' }
$d1 = Get-D1Health
if (-not $d1.Valid -or $d1.Pending -ne 0 -or $d1.Failures -ne 0 -or $d1.ActiveLease -ne 0) { throw 'd1 fixture failed' }

$userMode = 'wrong'; AssertThrows { Invoke-Preflight } 'gh user mismatch'; $userMode = 'ok'
$cronMode = 'mismatch'; AssertThrows { Invoke-Preflight } 'cron mismatch'; $cronMode = 'ok'
$d1Mode = 'pending'; AssertThrows { Get-D1Health } 'pending state'; $d1Mode = 'failure'; AssertThrows { Get-D1Health } 'failure state'; $d1Mode = 'lease'; AssertThrows { Get-D1Health } 'active lease'; $d1Mode = 'ok'
$writeMode = 'failure'; AssertThrows { Invoke-WriteCommand 'wrangler' @('versions','deploy') } 'deploy failure'; $writeMode = 'ok'
$healthMode = 'group-ok'; $groupHealth = Test-Health 'group' $true; if (-not $groupHealth.Checked -or -not $groupHealth.GroupConfigured) { throw 'group health fixture failed' }
$healthMode = 'group-missing'; AssertThrows { Test-Health 'group' $true } 'group not configured'
$healthMode = 'user-missing'; AssertThrows { Test-Health 'personal' $false } 'personal user not configured'
$healthMode = 'mode-mismatch'; AssertThrows { Test-Health 'personal' $true } 'health mode mismatch'
$healthMode = 'id-key'; AssertThrows { Test-Health 'personal' $false } 'health ID key'
$healthMode = 'unknown-key'; AssertThrows { Test-Health 'personal' $false } 'health unknown key'
$healthMode = 'http-failure'; AssertThrows { Test-Health 'personal' $false } 'health HTTP status'
$healthMode = 'personal-ok'

$HealthAdapter = $null
$httpHealthMode = 'ok'
function Invoke-WebRequest {
    param([string]$Method, [string]$Uri, [int]$TimeoutSec, [switch]$UseBasicParsing)
    if ($httpHealthMode -eq 'non200') { return [pscustomobject]@{ StatusCode = 500; Content = '{}' } }
    return [pscustomobject]@{ StatusCode = 200; Content = '{"line_destination_mode":"group","line_user_id_configured":true,"line_group_id_configured":true}' }
}
$httpHealth = Test-Health 'group' $true
if (-not $httpHealth.Checked -or -not $httpHealth.GroupConfigured) { throw 'HTTP JSON health path failed' }
$httpHealthMode = 'non200'; AssertThrows { Test-Health 'group' $true } 'HTTP non-200 path'; $httpHealthMode = 'ok'
$HealthAdapter = ${function:HealthFixture}
$ExpectedGroupConfigured = 'false'
$previous = [pscustomobject]@{ Active = [pscustomobject]@{ VersionId = 'old'; Percentage = 100 }; GithubMode = 'personal'; CloudflareMode = 'personal' }
$badRollback = [pscustomobject]@{ Active = [pscustomobject]@{ VersionId = 'new'; Percentage = 100 }; GithubMode = 'personal'; CloudflareMode = 'personal'; Health = [pscustomobject]@{ Checked = $true }; D1 = [pscustomobject]@{ Valid = $true }; EffectiveCron = [pscustomobject]@{ Available = $true; Crons = @('* * * * *') } }
AssertThrows { Assert-RollbackState $badRollback $previous } 'rollback state mismatch'
$writeCount = 0; [void](Invoke-Preflight); if ($writeCount -ne 0) { throw 'read-only preflight issued a write' }
Write-Output 'powershell-failure-injection=pass'
