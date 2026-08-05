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

    [string]$CurrentHealthUrl,

    [string]$TargetHealthUrl,

    [ValidateSet('true', 'false')]
    [string]$ExpectedGroupConfigured,

    [string]$DatabaseName = 'okaz-slot-watcher',

    [string]$ProductionConfig = 'cloudflare-worker/wrangler.production.toml'

    , [scriptblock]$ReadOnlyAdapter

    , [scriptblock]$WriteAdapter

    , [scriptblock]$HealthAdapter

    , [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$ExpectedOwnerRepo = 'u3comp/okaz-slot-watcher'
$ExpectedAccountId = '180e8e731977b6770c393cd5c17cab91'
$ExpectedCron = '* * * * *'
$ExpectedDatabaseId = '04c229e8-a76b-40a8-a4b4-17c78bdcf6ff'
$ExpectedCompatibilityDate = '2026-08-02'
$repoRoot = Split-Path -Parent $PSScriptRoot
$productionConfigPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $ProductionConfig))

function Invoke-ReadOnly {
    param([string]$File, [string[]]$Arguments)
    if ($ReadOnlyAdapter) { return (& $ReadOnlyAdapter $File $Arguments) }
    $restore = $null
    if ($File -eq 'wrangler') { $restore = (Get-Location).Path; Set-Location (Join-Path $repoRoot 'cloudflare-worker') }
    try { $output = & $File @Arguments 2>&1 }
    finally { if ($restore) { Set-Location $restore } }
    if ($LASTEXITCODE -ne 0) { throw "read-only command failed: $File" }
    return ($output -join [Environment]::NewLine)
}

function Invoke-WriteCommand {
    param([string]$File, [string[]]$Arguments)
    if ($WriteAdapter) {
        $result = & $WriteAdapter $File $Arguments
        if ($result -is [int] -and $result -ne 0) { throw "write command failed: $File" }
        return
    }
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
    return (Get-GithubVariableState).Mode
}

function Get-GithubVariableState {
    if ($ReadOnlyAdapter) {
        $json = Invoke-ReadOnly 'gh' @('variable', 'list', '--repo', $Repository, '--json', 'name,value')
        $items = @((Convert-JsonOrThrow $json 'GitHub variable list'))
        $item = $items | Where-Object { $_.name -eq 'LINE_DESTINATION_MODE' } | Select-Object -First 1
        if (-not $item) { return [pscustomobject]@{ State = 'absent'; Mode = 'personal'; HttpStatus = 404 } }
        if ([string]::IsNullOrWhiteSpace([string]$item.value)) { throw 'GitHub LINE_DESTINATION_MODE value is empty.' }
        $mode = [string]$item.value
        if ($mode -notin @('personal', 'group')) { throw 'GitHub LINE_DESTINATION_MODE value is invalid.' }
        return [pscustomobject]@{ State = $mode; Mode = $mode; HttpStatus = 200 }
    }
    $nativePreference = $PSNativeCommandUseErrorActionPreference
    $errorPreference = $ErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& gh api --method GET --include "repos/$Repository/actions/variables/LINE_DESTINATION_MODE" 2>&1)
        $ghExitCode = $LASTEXITCODE
    } finally {
        $PSNativeCommandUseErrorActionPreference = $nativePreference
        $ErrorActionPreference = $errorPreference
    }
    $statusLine = $output | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^HTTP/\S+\s+(\d{3})\s' } | Select-Object -First 1
    if (-not $statusLine) { throw 'GitHub variable status was not returned.' }
    $status = [int]([regex]::Match($statusLine, '\b(\d{3})\b').Groups[1].Value)
    if ($status -eq 404) { return [pscustomobject]@{ State = 'absent'; Mode = 'personal'; HttpStatus = 404 } }
    if ($status -ne 200 -or $ghExitCode -ne 0) { throw 'GitHub variable read failed.' }
    $bodyLine = $output | ForEach-Object { [string]$_ } | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -First 1
    $item = Convert-JsonOrThrow $bodyLine 'GitHub variable'
    if ([string]$item.name -ne 'LINE_DESTINATION_MODE' -or [string]::IsNullOrWhiteSpace([string]$item.value)) { throw 'GitHub variable response is invalid.' }
    $mode = [string]$item.value
    if ($mode -notin @('personal', 'group')) { throw 'GitHub LINE_DESTINATION_MODE value is invalid.' }
    return [pscustomobject]@{ State = $mode; Mode = $mode; HttpStatus = 200 }
}

function Get-EffectiveCron {
    try {
        $value = $null
        if ($ReadOnlyAdapter) {
            $json = Invoke-ReadOnly 'schedules-api' @('GET', $ExpectedAccountId, $WorkerName)
            $value = Convert-JsonOrThrow $json 'effective schedules API'
        } else {
            $token = [Environment]::GetEnvironmentVariable('OKAZ_CF_SCHEDULES_READ_TOKEN')
            if ([string]::IsNullOrWhiteSpace($token)) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 0 } }
            try {
                $uri = "https://api.cloudflare.com/client/v4/accounts/$ExpectedAccountId/workers/scripts/$WorkerName/schedules"
                $headers = @{ Authorization = "Bearer $token" }
                $response = Invoke-WebRequest -Method Get -Uri $uri -Headers $headers -TimeoutSec 15 -UseBasicParsing
                if ([int]$response.StatusCode -ne 200) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 0 } }
                $value = Convert-JsonOrThrow $response.Content 'effective schedules API'
            } finally {
                $headers = $null
                $token = $null
            }
        }
        if ($value.success -ne $true) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 0 } }
        if (@($value.errors).Count -ne 0) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 0 } }
        $items = @($value.result.schedules)
        if ($items.Count -ne 1) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = $items.Count } }
        $item = $items[0]
        $cron = [string]$item.cron
        $created = [datetime]::MinValue
        $modified = [datetime]::MinValue
        if (-not [datetime]::TryParse([string]$item.created_on, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$created)) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 1 } }
        if (-not [datetime]::TryParse([string]$item.modified_on, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$modified)) { return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 1 } }
        if ($cron -ne $ExpectedCron) { return [pscustomobject]@{ Available = $false; Crons = @($cron); ScheduleCount = 1; CreatedOn = $item.created_on; ModifiedOn = $item.modified_on } }
        return [pscustomobject]@{ Available = $true; Crons = @($cron); ScheduleCount = 1; CreatedOn = [string]$item.created_on; ModifiedOn = [string]$item.modified_on }
    } catch {
        return [pscustomobject]@{ Available = $false; Crons = @(); ScheduleCount = 0 }
    }
}

function Get-D1Health {
    $sql = "SELECT version, json_array_length(state_json, '$.pending_notifications') AS pending_count, json_extract(state_json, '$.consecutive_total_failures') AS failures, (SELECT COUNT(*) FROM watcher_lock WHERE id = 1 AND lease_until_ms > (strftime('%s','now') * 1000)) AS active_lease_count FROM watcher_state WHERE id = 1;"
    $json = Invoke-ReadOnly 'wrangler' @('d1', 'execute', $DatabaseName, '--remote', '--json', '--command', $sql)
    $value = Convert-JsonOrThrow $json 'D1 state query'
    $rows = @($value | ForEach-Object { $_.results } | Where-Object { $_ })
    if ($rows.Count -ne 1) { throw 'D1 state query did not return exactly one row.' }
    $row = $rows[0]
    if ([int]$row.pending_count -ne 0) { throw 'D1 pending_notifications is not empty.' }
    if ([int]$row.failures -ne 0) { throw 'D1 consecutive_total_failures is not zero.' }
    if ([int]$row.active_lease_count -ne 0) { throw 'D1 has an active lease.' }
    return [pscustomobject]@{ Valid = $true; Version = [int]$row.version; Pending = [int]$row.pending_count; Failures = [int]$row.failures; ActiveLease = [int]$row.active_lease_count }
}

function Assert-RollbackState {
    param($State, $Previous)
    if ($State.Active.VersionId -ne $Previous.Active.VersionId -or $State.Active.Percentage -ne 100 -or $State.GithubMode -ne $Previous.GithubMode -or $State.GithubState.State -ne $Previous.GithubState.State -or $State.CloudflareMode -ne $Previous.CloudflareMode -or -not $State.CurrentHealth.Checked -or -not $State.TargetHealth.Checked -or -not $State.D1.Valid -or -not $State.EffectiveCron.Available -or @($State.EffectiveCron.Crons).Count -ne 1 -or @($State.EffectiveCron.Crons)[0] -ne $ExpectedCron) { throw 'rollback post-check failed.' }
}

function Assert-HealthPayload {
    param($Health, [string]$ExpectedMode, [bool]$ExpectedGroupConfiguredValue)
    if (-not $Health -or $Health -is [array]) { throw 'Cloudflare health response must be one JSON object.' }
    $allowed = @('line_destination_mode', 'line_user_id_configured', 'line_group_id_configured')
    $keys = @($Health.PSObject.Properties.Name)
    if ($keys.Count -ne $allowed.Count -or @($keys | Where-Object { $_ -notin $allowed }).Count -ne 0 -or @($allowed | Where-Object { $_ -notin $keys }).Count -ne 0) {
        throw 'Cloudflare health response schema is not the exact allowlist.'
    }
    if ([string]$Health.line_destination_mode -ne $ExpectedMode) { throw 'Cloudflare health mode does not match the expected mode.' }
    if ($Health.line_user_id_configured -isnot [bool] -or $Health.line_user_id_configured -ne $true) { throw 'Cloudflare health user configuration is not true.' }
    if ($Health.line_group_id_configured -isnot [bool]) { throw 'Cloudflare health group configuration is not boolean.' }
    if ([bool]$Health.line_group_id_configured -ne $ExpectedGroupConfiguredValue) { throw 'Cloudflare health group configuration does not match the expected migration stage.' }
    if ($ExpectedMode -eq 'group' -and -not $ExpectedGroupConfiguredValue) { throw 'Group mode requires the group destination to be configured.' }
    return [pscustomobject]@{
        Checked = $true
        Mode = [string]$Health.line_destination_mode
        UserConfigured = [bool]$Health.line_user_id_configured
        GroupConfigured = [bool]$Health.line_group_id_configured
    }
}

function Test-Health {
    param([string]$ExpectedMode, [bool]$ExpectedGroupConfiguredValue, [string]$ProbeUrl)
    $url = if (-not [string]::IsNullOrWhiteSpace($ProbeUrl)) { $ProbeUrl } elseif (-not [string]::IsNullOrWhiteSpace($HealthUrl)) { $HealthUrl } else { $null }
    if ([string]::IsNullOrWhiteSpace($url)) { return [pscustomobject]@{ Checked = $false; Mode = $null } }
    if ($HealthAdapter) {
        $adapted = & $HealthAdapter $url
        if ([int]$adapted.StatusCode -ne 200) { throw 'Cloudflare health endpoint did not return HTTP 200.' }
        return Assert-HealthPayload $adapted.Body $ExpectedMode $ExpectedGroupConfiguredValue
    }
    $response = Invoke-WebRequest -Method Get -Uri $url -TimeoutSec 15 -UseBasicParsing
    if ($response.StatusCode -ne 200) { throw 'Cloudflare health endpoint did not return HTTP 200.' }
    $health = Convert-JsonOrThrow $response.Content 'Cloudflare health'
    return Assert-HealthPayload $health $ExpectedMode $ExpectedGroupConfiguredValue
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
    $githubUser = (Invoke-ReadOnly 'gh' @('api', 'user', '--jq', '.login')).Trim()
    if ($githubUser -ne 'u3comp') { throw 'GitHub user mismatch.' }
    $whoami = Invoke-ReadOnly 'wrangler' @('whoami')
    if ($whoami -notmatch [regex]::Escape($ExpectedAccountId)) { throw 'Cloudflare account mismatch.' }
    $active = Get-ActiveDeployment
    $activeVersion = Get-Version $active.VersionId
    if ($activeVersion.id -ne $active.VersionId) { throw 'active version identity mismatch.' }
    if ([string]$activeVersion.resources.script_runtime.compatibility_date -ne $ExpectedCompatibilityDate) { throw 'active compatibility date mismatch.' }
    if (@($activeVersion.resources.script.handlers) -notcontains 'scheduled' -or @($activeVersion.resources.script.handlers) -notcontains 'fetch') { throw 'active handlers mismatch.' }
    $activeDb = Get-Binding $activeVersion 'DB'
    if (-not $activeDb -or [string]$activeDb.database_id -ne $ExpectedDatabaseId) { throw 'active D1 binding mismatch.' }
    $targetId = if ($CloudflareVersionId) { $CloudflareVersionId } else { $active.VersionId }
    $target = Get-Version $targetId
    $githubState = Get-GithubVariableState
    $githubMode = $githubState.Mode
    $cloudflareMode = Get-ModeFromVersion $activeVersion
    if ($githubMode -ne $cloudflareMode) { throw 'GitHub and Cloudflare destination modes differ.' }
    $targetMode = Get-ModeFromVersion $target
    if ($targetMode -ne $Mode) { throw 'target version mode does not match requested mode.' }
    $expectedGroup = if (-not [string]::IsNullOrWhiteSpace($ExpectedGroupConfigured)) { [bool]::Parse($ExpectedGroupConfigured) } else { [bool](Get-Binding $target 'LINE_GROUP_ID') }
    $currentUrl = if (-not [string]::IsNullOrWhiteSpace($CurrentHealthUrl)) { $CurrentHealthUrl } elseif (-not [string]::IsNullOrWhiteSpace($HealthUrl)) { $HealthUrl } else { $null }
    $targetUrl = if (-not [string]::IsNullOrWhiteSpace($TargetHealthUrl)) { $TargetHealthUrl } elseif (-not [string]::IsNullOrWhiteSpace($HealthUrl)) { $HealthUrl } else { $null }
    $currentHealth = Test-Health $cloudflareMode $expectedGroup $currentUrl
    $targetHealth = Test-Health $targetMode $expectedGroup $targetUrl
    $cron = Get-EffectiveCron
    if (-not $cron.Available -or @($cron.Crons).Count -ne 1 -or @($cron.Crons)[0] -ne $ExpectedCron) { throw 'effective Cron could not be verified.' }
    $d1 = Get-D1Health
    [pscustomobject]@{
        Active = $active
        ActiveVersion = $activeVersion
        Target = $target
        TargetId = $targetId
        TargetMode = $targetMode
        GithubState = $githubState
        GithubMode = $githubMode
        CloudflareMode = $cloudflareMode
        CurrentHealth = $currentHealth
        TargetHealth = $targetHealth
        Cron = $ExpectedCron
        EffectiveCron = $cron
        D1 = $d1
        GithubUser = $githubUser
    }
}

if ($LibraryOnly) { return }
if ($WhatIf -and $Apply) { throw '-WhatIf and -Apply cannot be used together.' }
if (-not $WhatIf -and -not $Apply) { throw 'No mutation is performed by default. Use -WhatIf or -Apply after human approval.' }
if ($Apply -and [string]::IsNullOrWhiteSpace($CloudflareVersionId)) { throw '-CloudflareVersionId is required for -Apply.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh CLI is not available.' }
if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) { throw 'wrangler CLI is not available.' }

$preflight = Invoke-Preflight
$targetMode = Get-ModeFromVersion $preflight.Target
if ($targetMode -ne $Mode) { throw 'target version mode does not match requested mode.' }
if ([string]$preflight.Target.resources.script_runtime.compatibility_date -ne $ExpectedCompatibilityDate) { throw 'target compatibility date mismatch.' }
if (@($preflight.Target.resources.script.handlers) -notcontains 'scheduled' -or @($preflight.Target.resources.script.handlers) -notcontains 'fetch') { throw 'target handlers mismatch.' }
$targetDb = Get-Binding $preflight.Target 'DB'
if (-not $targetDb -or [string]$targetDb.database_id -ne $ExpectedDatabaseId) { throw 'target D1 binding mismatch.' }
if ($WhatIf -and (-not $preflight.CurrentHealth.Checked -or -not $preflight.TargetHealth.Checked)) { throw 'CurrentHealthUrl and TargetHealthUrl are required for -WhatIf.' }
if ($Apply -and (-not $preflight.EffectiveCron.Available -or @($preflight.EffectiveCron.Crons).Count -ne 1 -or @($preflight.EffectiveCron.Crons)[0] -ne $ExpectedCron)) { throw 'effective Cron could not be verified.' }
if ($Apply -and (-not $preflight.CurrentHealth.Checked -or -not $preflight.TargetHealth.Checked)) { throw 'CurrentHealthUrl and TargetHealthUrl are required for -Apply.' }
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
Write-Output "health_probe=$([string]($preflight.CurrentHealth.Checked -and $preflight.TargetHealth.Checked))"
Write-Output "current_health_probe=$([string]$preflight.CurrentHealth.Checked)"
Write-Output "target_health_probe=$([string]$preflight.TargetHealth.Checked)"
Write-Output "github_user_verified=$([string]($preflight.GithubUser -eq 'u3comp'))"
Write-Output "effective_cron_probe=$([string]$preflight.EffectiveCron.Available)"
Write-Output "schedule_count=$($preflight.EffectiveCron.ScheduleCount)"
Write-Output "d1_state_valid=$([string]$preflight.D1.Valid)"
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
    if ($post.Active.VersionId -ne $CloudflareVersionId -or $post.Active.Percentage -ne 100 -or $post.GithubMode -ne $Mode -or $post.CloudflareMode -ne $Mode -or -not $post.CurrentHealth.Checked -or -not $post.TargetHealth.Checked -or -not $post.D1.Valid -or -not $post.EffectiveCron.Available -or @($post.EffectiveCron.Crons).Count -ne 1 -or @($post.EffectiveCron.Crons)[0] -ne $ExpectedCron) { throw 'post-check failed.' }
    Write-Output 'apply=passed'
} catch {
    $rollbackOk = $true
    try {
        if ($cloudflareChanged) { Invoke-WriteCommand 'wrangler' @('versions', 'deploy', "$($previous.Active.VersionId)@100%", '--name', $WorkerName, '--config', $productionConfigPath, '--message', 'Rollback destination switch after failed post-check', '-y') }
        if ($githubChanged) {
            if ($previous.GithubState.State -eq 'absent') {
                Invoke-WriteCommand 'gh' @('variable', 'delete', 'LINE_DESTINATION_MODE', '--repo', $Repository)
            } else {
                Invoke-WriteCommand 'gh' @('variable', 'set', 'LINE_DESTINATION_MODE', '--body', $previous.GithubMode, '--repo', $Repository)
            }
        }
        $rollbackState = Invoke-Preflight
        Assert-RollbackState $rollbackState $previous
    } catch { $rollbackOk = $false }
    if (-not $rollbackOk) { throw "INCONSISTENT_DESTINATION_STATE: rollback failed after gate error." }
    throw
}
