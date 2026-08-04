param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('personal', 'group')]
    [string]$Mode,

    [switch]$WhatIf,

    [switch]$Apply,

    [string]$Repository = 'u3comp/okaz-slot-watcher',

    [string]$WorkerName = 'okaz-slot-watcher-cf',

    [string]$CloudflareVersionId,

    [string]$ApprovalRecord = 'docs/status/2026-08-05_line-group-destination-validation.md',

    [string]$HealthUrl,

    [string]$DatabaseName = 'okaz-slot-watcher',

    [string]$ProductionConfig = 'cloudflare-worker/wrangler.production.toml'
)

$ErrorActionPreference = 'Stop'
$ExpectedOwnerRepo = 'u3comp/okaz-slot-watcher'
$ExpectedAccountId = '180e8e731977b6770c393cd5c17cab91'
$ExpectedCron = '* * * * *'
$ExpectedDatabaseId = '04c229e8-a76b-40a8-a4b4-17c78bdcf6ff'
$repoRoot = Split-Path -Parent $PSScriptRoot
$productionConfigPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $ProductionConfig))

function Invoke-ReadOnly {
    param([string]$File, [string[]]$Arguments)
    $restore = $null
    if ($File -eq 'wrangler') { $restore = (Get-Location).Path; Set-Location (Join-Path $repoRoot 'cloudflare-worker') }
    try { $output = & $File @Arguments 2>&1 }
    finally { if ($restore) { Set-Location $restore } }
    if ($LASTEXITCODE -ne 0) { throw "read-only command failed: $File" }
    return ($output -join [Environment]::NewLine)
}

function Invoke-WriteCommand {
    param([string]$File, [string[]]$Arguments)
    $restore = $null
    if ($File -eq 'wrangler') { $restore = (Get-Location).Path; Set-Location (Join-Path $repoRoot 'cloudflare-worker') }
    try { & $File @Arguments 2>&1 | Out-Null }
    finally { if ($restore) { Set-Location $restore } }
    if ($LASTEXITCODE -ne 0) { throw "write command failed: $File" }
}

function Convert-JsonOrThrow {
    param($Text, [string]$Label)
    if ($Text -is [array]) { $Text = $Text -join [Environment]::NewLine }
    else { $Text = [string]$Text }
    $Text = $Text.Trim()
    $start = $Text.IndexOf('{')
    $end = $Text.LastIndexOf('}')
    if (-not $Text.StartsWith('[') -and $start -ge 0 -and $end -gt $start) { $Text = $Text.Substring($start, $end - $start + 1) }
    try { return $Text | ConvertFrom-Json }
    catch { throw "invalid JSON from $Label" }
}

function Get-Binding {
    param($Version, [string]$Name)
    $bindings = @($Version.resources.bindings)
    return $bindings | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

function Get-ActiveDeployment {
    $json = Invoke-ReadOnly 'wrangler' @('deployments', 'status', '--name', $WorkerName, '--json')
    $value = Convert-JsonOrThrow $json 'deployments status'
    $version = @($value.versions | Where-Object { [int]$_.percentage -eq 100 }) | Select-Object -First 1
    if (-not $version) { throw 'active deployment is not exactly 100 percent.' }
    return [pscustomobject]@{ Raw = $value; DeploymentId = [string]$value.id; VersionId = [string]$version.version_id; Percentage = [int]$version.percentage }
}

function Get-Version {
    param([string]$VersionId)
    $json = Invoke-ReadOnly 'wrangler' @('versions', 'view', $VersionId, '--name', $WorkerName, '--json')
    return Convert-JsonOrThrow $json 'version view'
}

function Get-ModeFromVersion {
    param($Version)
    $binding = Get-Binding $Version 'LINE_DESTINATION_MODE'
    if (-not $binding -or $binding.type -ne 'plain_text') { return 'personal' }
    $value = [string]$binding.text
    if ($value -notin @('personal', 'group')) { return 'invalid' }
    return $value
}

function Get-DestinationMode {
    $json = Invoke-ReadOnly 'gh' @('variable', 'list', '--repo', $Repository, '--json', 'name,value')
    $items = @((Convert-JsonOrThrow $json 'GitHub variable list'))
    $item = $items | Where-Object { $_.name -eq 'LINE_DESTINATION_MODE' } | Select-Object -First 1
    if (-not $item -or [string]::IsNullOrWhiteSpace([string]$item.value)) { return 'personal' }
    $mode = [string]$item.value
    if ($mode -notin @('personal', 'group')) { return 'invalid' }
    return $mode
}

function Test-Health {
    param([string]$ExpectedMode)
    if ([string]::IsNullOrWhiteSpace($HealthUrl)) { return [pscustomobject]@{ Checked = $false; Mode = $null } }
    $response = Invoke-WebRequest -Method Get -Uri $HealthUrl -TimeoutSec 15 -UseBasicParsing
    if ($response.StatusCode -ne 200) { throw 'Cloudflare health endpoint did not return HTTP 200.' }
    $health = Convert-JsonOrThrow $response.Content 'Cloudflare health'
    $safeMode = [string]$health.line_destination_mode
    if ($safeMode -ne $ExpectedMode) { throw 'Cloudflare health mode does not match the expected mode.' }
    return [pscustomobject]@{ Checked = $true; Mode = $safeMode }
}

function Invoke-Preflight {
    if ($Repository -ne $ExpectedOwnerRepo) { throw 'repository mismatch.' }
    $configPath = Join-Path $repoRoot $ProductionConfig
    if (-not (Test-Path -LiteralPath $configPath)) { throw "production config not found: $ProductionConfig" }
    $configText = Get-Content -Raw -Encoding UTF8 $configPath
    if ($configText -notmatch 'crons\s*=\s*\[\s*"\* \* \* \* \*"\s*\]') { throw 'production config cron mismatch.' }
    $root = (Invoke-ReadOnly 'git' @('-C', $repoRoot, 'rev-parse', '--show-toplevel')).Trim()
    if ([IO.Path]::GetFullPath($root) -ne [IO.Path]::GetFullPath($repoRoot)) { throw 'Git repository root mismatch.' }
    $remote = (Invoke-ReadOnly 'git' @('-C', $repoRoot, 'remote', 'get-url', 'origin')).Trim()
    if ($remote -notmatch 'github\.com[/:]u3comp/okaz-slot-watcher(?:\.git)?$') { throw 'origin repository mismatch.' }
    [void](Invoke-ReadOnly 'gh' @('auth', 'status', '--hostname', 'github.com'))
    [void](Invoke-ReadOnly 'gh' @('api', 'user', '--jq', '.login'))
    $whoami = Invoke-ReadOnly 'wrangler' @('whoami')
    if ($whoami -notmatch [regex]::Escape($ExpectedAccountId)) { throw 'Cloudflare account mismatch.' }
    $active = Get-ActiveDeployment
    $activeVersion = Get-Version $active.VersionId
    if ($activeVersion.id -ne $active.VersionId) { throw 'active version identity mismatch.' }
    if (@($activeVersion.resources.script.handlers) -notcontains 'scheduled' -or @($activeVersion.resources.script.handlers) -notcontains 'fetch') { throw 'active handlers mismatch.' }
    $activeDb = Get-Binding $activeVersion 'DB'
    if (-not $activeDb -or [string]$activeDb.database_id -ne $ExpectedDatabaseId) { throw 'active D1 binding mismatch.' }
    $githubMode = Get-DestinationMode
    $cloudflareMode = Get-ModeFromVersion $activeVersion
    if ($githubMode -ne $cloudflareMode) { throw 'GitHub and Cloudflare destination modes differ.' }
    $health = Test-Health $cloudflareMode
    # This command is deliberately a read-only health query; its output is not
    # printed because it may contain state details unrelated to this gate.
    [void](Invoke-ReadOnly 'wrangler' @('d1', 'execute', $DatabaseName, '--remote', '--command', "SELECT version, json_array_length(state_json, '$.pending_notifications') AS pending_count, json_extract(state_json, '$.consecutive_total_failures') AS failures FROM watcher_state WHERE id = 1; SELECT COUNT(*) AS active_lease FROM watcher_lock WHERE id = 1 AND lease_until_ms > (strftime('%s','now') * 1000);"))
    $targetId = if ($CloudflareVersionId) { $CloudflareVersionId } else { $active.VersionId }
    $target = Get-Version $targetId
    [pscustomobject]@{
        Active = $active
        ActiveVersion = $activeVersion
        Target = $target
        TargetId = $targetId
        GithubMode = $githubMode
        CloudflareMode = $cloudflareMode
        Health = $health
        Cron = $ExpectedCron
    }
}

if ($WhatIf -and $Apply) { throw '-WhatIf and -Apply cannot be used together.' }
if (-not $WhatIf -and -not $Apply) { throw 'No mutation is performed by default. Use -WhatIf or -Apply after human approval.' }
if ($Apply -and [string]::IsNullOrWhiteSpace($CloudflareVersionId)) { throw '-CloudflareVersionId is required for -Apply.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh CLI is not available.' }
if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) { throw 'wrangler CLI is not available.' }

$preflight = Invoke-Preflight
$targetMode = Get-ModeFromVersion $preflight.Target
if ($targetMode -ne $Mode) { throw 'target version mode does not match requested mode.' }
if ($Apply) {
    $recordPath = Join-Path $repoRoot $ApprovalRecord
    if (-not (Test-Path -LiteralPath $recordPath)) { throw 'reviewed approval record is required.' }
    $record = Get-Content -Raw -Encoding UTF8 $recordPath
    if ($record -notmatch [regex]::Escape($CloudflareVersionId) -or $record -notmatch "Target-Mode:\s*$Mode") { throw 'target version is not present in the approval record.' }
}

Write-Output "preflight=passed"
Write-Output "active_version=$($preflight.Active.VersionId)"
Write-Output "active_percentage=$($preflight.Active.Percentage)"
Write-Output "current_mode=$($preflight.GithubMode)"
Write-Output "target_version=$($preflight.TargetId)"
Write-Output "health_probe=$([string]$preflight.Health.Checked)"
Write-Output "production_config=$ProductionConfig"
Write-Output 'secrets_read=false'

if ($WhatIf) {
    Write-Output "whatif=read_only; planned_mode=$Mode; no deploy, variable, secret, cron, D1, webhook, or push"
    exit 0
}

$previous = $preflight
$cloudflareChanged = $false
$githubChanged = $false
try {
    Invoke-WriteCommand 'wrangler' @('versions', 'deploy', "$CloudflareVersionId@100%", '--name', $WorkerName, '--config', $productionConfigPath, '--message', "Set LINE destination mode to $Mode", '-y')
    $cloudflareChanged = $true
    Invoke-WriteCommand 'gh' @('variable', 'set', 'LINE_DESTINATION_MODE', '--body', $Mode, '--repo', $Repository)
    $githubChanged = $true
    $post = Invoke-Preflight
    if ($post.Active.VersionId -ne $CloudflareVersionId -or $post.Active.Percentage -ne 100 -or $post.GithubMode -ne $Mode -or $post.CloudflareMode -ne $Mode) { throw 'post-check failed.' }
    Write-Output 'apply=passed'
} catch {
    $rollbackOk = $true
    try {
        if ($cloudflareChanged) { Invoke-WriteCommand 'wrangler' @('versions', 'deploy', "$($previous.Active.VersionId)@100%", '--name', $WorkerName, '--config', $productionConfigPath, '--message', 'Rollback destination switch after failed post-check', '-y') }
        if ($githubChanged -and $previous.GithubMode) { Invoke-WriteCommand 'gh' @('variable', 'set', 'LINE_DESTINATION_MODE', '--body', $previous.GithubMode, '--repo', $Repository) }
    } catch { $rollbackOk = $false }
    if (-not $rollbackOk) { throw "INCONSISTENT_DESTINATION_STATE: rollback failed after gate error." }
    throw
}
