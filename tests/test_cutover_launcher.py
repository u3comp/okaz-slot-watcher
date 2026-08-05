from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "invoke-approved-group-cutover.ps1"


def test_launcher_uses_one_process_token_lifecycle_and_fail_closed_gates():
    text = SCRIPT.read_text(encoding="utf-8")
    for marker in (
        "Read-Host 'Cloudflare schedules read Tokenを貼り付けてEnter' -AsSecureString",
        "SetEnvironmentVariable($tokenName, $plainToken, 'Process')",
        "SetEnvironmentVariable($tokenName, $null, 'Process')",
        "Invoke-GatedSwitch -Mode group",
        "Invoke-GatedSwitch -Mode personal",
        "-ExecuteApply",
        "token_value_logged = $false",
        "gated_switch_failed",
        "inconsistent_destination_state",
        "child_token_not_inherited",
        "child_token_inherited = $childTokenInherited",
        "failure_phase = $failurePhase",
        "effective_cron_unverified",
    ):
        assert marker in text


def test_launcher_never_outputs_or_persists_token_value():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "Write-Output $plainToken" not in text
    assert "Set-Content -LiteralPath $resultPath -Value $plainToken" not in text
    assert ".env" not in text
    assert ".dev.vars" not in text
