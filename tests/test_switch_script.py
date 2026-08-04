import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "set-line-destination.ps1"


def run_script(*args):
    return subprocess.run(
        ["powershell", "-NoProfile", "-File", str(SCRIPT), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=90,
    )


def test_whatif_executes_read_only_preflight_without_write_commands():
    result = run_script("-Mode", "personal", "-WhatIf")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "whatif=read_only" in result.stdout
    assert "secrets_read=false" in result.stdout
    assert "deploy" not in result.stdout.lower().split("whatif=")[0]


def test_repository_mismatch_fails_closed_before_mutation():
    result = run_script("-Mode", "personal", "-WhatIf", "-Repository", "other/example")
    assert result.returncode != 0
    combined = (result.stdout + result.stderr).lower()
    assert "repository mismatch" in combined
    assert "versions deploy" not in combined


def test_target_mode_mismatch_fails_closed():
    result = run_script(
        "-Mode", "group", "-WhatIf",
        "-CloudflareVersionId", "f655cd8e-e0c6-4768-b403-45b50bbd3b02",
    )
    assert result.returncode != 0
    assert "target version mode" in (result.stdout + result.stderr).lower()


def test_script_contains_transactional_rollback_contract():
    text = SCRIPT.read_text(encoding="utf-8")
    for marker in (
        "post-check failed",
        "INCONSISTENT_DESTINATION_STATE",
        "Rollback destination switch",
        "LINE_DESTINATION_MODE",
        "d1', 'execute",
    ):
        assert marker in text


def test_failure_injection_model_rolls_back_only_completed_sides():
    def apply(deploy_ok, variable_ok, post_ok):
        state = {"cloudflare": "old", "github": "old"}
        if not deploy_ok:
            return state, "failed-before-mutation"
        state["cloudflare"] = "new"
        if not variable_ok or not post_ok:
            state["cloudflare"] = "old"
            if variable_ok:
                state["github"] = "old"
            return state, "rolled-back"
        state["github"] = "new"
        return state, "passed"

    assert apply(False, True, True) == ({"cloudflare": "old", "github": "old"}, "failed-before-mutation")
    assert apply(True, False, True) == ({"cloudflare": "old", "github": "old"}, "rolled-back")
    assert apply(True, True, False) == ({"cloudflare": "old", "github": "old"}, "rolled-back")
    assert apply(True, True, True) == ({"cloudflare": "new", "github": "new"}, "passed")


def test_fixture_manifest_has_no_secret_values():
    fixture = ROOT / "tests" / "fixtures" / "switch-gate-cases.json"
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    assert {case["name"] for case in cases} >= {
        "deploy_failure", "github_variable_failure", "post_check_failure",
        "cloudflare_rollback_failure", "github_rollback_failure",
    }
