[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('personal', 'group')]
    [string]$Mode,

    [switch]$WhatIf,

    [switch]$Apply,

    [string]$Repository = 'u3comp/okaz-slot-watcher',

    [string]$WorkerName = 'okaz-slot-watcher-cf',

    [string]$CloudflareVersionId
)

$ErrorActionPreference = 'Stop'

if ($WhatIf -and $Apply) {
    throw '-WhatIf and -Apply cannot be used together.'
}

if (-not $WhatIf -and -not $Apply) {
    throw 'No production mutation is performed by default. Use -WhatIf for the plan or -Apply only after human approval.'
}

if ($WhatIf) {
    @(
        "mode=$Mode"
        "github_repository=$Repository"
        "cloudflare_worker=$WorkerName"
        'planned_github_change=LINE_DESTINATION_MODE only'
        'planned_cloudflare_change=promote a pre-uploaded, reviewed version only'
        'secrets_read=false'
        'production_cron_change=none'
        'dry_run=true'
        'remote_push=false'
    ) | Write-Output
    exit 0
}

if (-not $CloudflareVersionId) {
    throw '-CloudflareVersionId is required for -Apply. Upload and review the version separately.'
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh CLI is not available.' }
if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) { throw 'wrangler CLI is not available.' }

Write-Output 'Verifying GitHub and Cloudflare CLI sessions.'
gh auth status --hostname github.com | Out-Null
wrangler whoami | Out-Null

Write-Output "Promoting the pre-approved Cloudflare version for mode=$Mode."
wrangler versions deploy "$CloudflareVersionId@100%" --name $WorkerName --message "Set LINE destination mode to $Mode" -y | Out-Null

Write-Output 'Updating the GitHub Repository Variable.'
gh variable set LINE_DESTINATION_MODE --body $Mode --repo $Repository | Out-Null

Write-Output "destination_mode=$Mode"
Write-Output 'Secrets and destination IDs were not read or printed.'
