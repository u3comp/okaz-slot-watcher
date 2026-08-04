from pathlib import Path
import tomllib


def test_production_config_is_canonical_and_secret_free():
    path = Path(__file__).parents[1] / "cloudflare-worker" / "wrangler.production.toml"
    config = tomllib.loads(path.read_text(encoding="utf-8"))
    assert config["name"] == "okaz-slot-watcher-cf"
    assert config["main"] == "src/index.ts"
    assert config["compatibility_date"] == "2026-08-02"
    assert config["triggers"]["crons"] == ["* * * * *"]
    d1 = config["d1_databases"][0]
    assert d1["binding"] == "DB"
    assert d1["database_id"] == "04c229e8-a76b-40a8-a4b4-17c78bdcf6ff"
    assert config["vars"]["DRY_RUN"] == "false"
    assert config["vars"]["LINE_ENABLED"] == "true"
    assert config["vars"]["LINE_DESTINATION_MODE"] == "personal"
    text = path.read_text(encoding="utf-8")
    assert "DISCORD_WEBHOOK_URL =" not in text
    assert "LINE_CHANNEL_ACCESS_TOKEN =" not in text
    assert "LINE_USER_ID =" not in text
