"""Unit tests for hooks/record_snapshot.py."""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from hooks.record_snapshot import extract_snapshot, save_snapshot


class TestExtractSnapshot:
    def test_extract_snapshot_empty(self):
        assert extract_snapshot(None, None) is None
        assert extract_snapshot({}, {}) is None

    def test_extract_snapshot_no_email(self):
        status = {"userStatus": {"name": ""}}
        assert extract_snapshot(status, {}) is None

    def test_extract_snapshot_groups(self):
        raw_status = {
            "userStatus": {
                "email": "dev@antigravity.io",
                "userTier": {"name": "Pro"},
            }
        }
        raw_summary = {
            "response": {
                "groups": [
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            {
                                "bucketId": "gemini_5h",
                                "window": "5h",
                                "remainingFraction": 0.9,
                                "resetTime": "2026-11-01T20:00:00Z",
                            },
                            {
                                "bucketId": "gemini_weekly",
                                "window": "weekly",
                                "remainingFraction": 0.75,
                                "resetTime": "2026-11-08T00:00:00Z",
                            },
                        ],
                    },
                    {
                        "displayName": "Claude Models",
                        "buckets": [
                            {
                                "bucketId": "claude_3p_5h",
                                "window": "5h",
                                "remainingFraction": 0.45,
                                "resetTime": "2026-11-01T22:30:00Z",
                            }
                        ],
                    },
                    {
                        "displayName": "Argon Models",
                        "buckets": [
                            {
                                "bucketId": "argon_weekly",
                                "window": "weekly",
                                "remainingFraction": 0.6,
                                "resetTime": "2026-11-07T12:00:00Z",
                            }
                        ],
                    },
                ]
            }
        }

        snapshot = extract_snapshot(raw_status, raw_summary)
        assert snapshot is not None
        assert snapshot["email"] == "dev@antigravity.io"
        assert snapshot["plan"] == "Pro"
        assert "pools" in snapshot

        pools = snapshot["pools"]
        assert "gemini_5h" in pools
        assert pools["gemini_5h"]["remaining_fraction"] == 0.9
        assert "claude_5h" in pools
        assert pools["claude_5h"]["remaining_fraction"] == 0.45
        assert "argon_weekly" in pools
        assert pools["argon_weekly"]["remaining_fraction"] == 0.6

    def test_extract_snapshot_fallback_configs(self):
        raw_status = {
            "userStatus": {
                "email": "user@example.com",
                "clientModelConfigs": [
                    {
                        "label": "Claude 3.5 Sonnet",
                        "quotaInfo": {
                            "remainingFraction": 0.8,
                            "resetTime": "2026-11-01T23:00:00Z",
                        },
                    },
                    {
                        "label": "Gemini 1.5 Pro",
                        "quotaInfo": {
                            "remainingFraction": 0.95,
                            "resetTime": "2026-11-02T04:00:00Z",
                        },
                    },
                ],
            }
        }
        # summary is empty
        snapshot = extract_snapshot(raw_status, {})
        assert snapshot is not None
        assert "claude_5h" in snapshot["pools"]
        assert snapshot["pools"]["claude_5h"]["remaining_fraction"] == 0.8
        assert "gemini_5h" in snapshot["pools"]


class TestSaveSnapshotPermissions:
    def test_save_snapshot_0600(self, tmp_path: Path):
        test_file = tmp_path / "mock_snapshots.json"
        with patch("hooks.record_snapshot.SNAPSHOT_FILE", test_file):
            sample = {
                "email": "security@test.com",
                "plan": "Pro",
                "last_seen_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                "pools": {},
            }
            save_snapshot(sample)
            assert test_file.exists()
            mode = test_file.stat().st_mode & 0o777
            assert mode == 0o600

            data = json.loads(test_file.read_text(encoding="utf-8"))
            assert "security@test.com" in data["accounts"]


class TestHookStdoutJsonInvariant:
    def test_hook_runs_and_outputs_valid_json(self):
        # Even when language_server is not reachable, the hook must return {} and exit 0
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "hooks" / "record_snapshot.py")],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        parsed = json.loads(result.stdout.strip())
        assert isinstance(parsed, dict)
