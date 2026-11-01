"""Unit tests for bin/quota_tracker.py."""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from bin.quota_tracker import (
    format_pool_cell,
    load_snapshots,
    parse_iso_or_epoch,
    save_snapshots,
)


class TestParseIsoOrEpoch:
    def test_none_and_empty(self):
        assert parse_iso_or_epoch(None) is None
        assert parse_iso_or_epoch("") is None
        assert parse_iso_or_epoch("   ") is None

    def test_epoch_numeric(self):
        # 1700000000 -> 2023-11-14 22:13:20 UTC
        res = parse_iso_or_epoch(1700000000)
        assert res is not None
        assert res.tzinfo == dt.timezone.utc
        assert res.year == 2023

    def test_epoch_zero_or_negative(self):
        assert parse_iso_or_epoch(0) is None
        assert parse_iso_or_epoch(-100) is None

    def test_epoch_string(self):
        res = parse_iso_or_epoch("1700000000")
        assert res is not None
        assert res.year == 2023

    def test_iso_with_z(self):
        res = parse_iso_or_epoch("2026-11-01T12:00:00Z")
        assert res is not None
        assert res.year == 2026
        assert res.month == 11
        assert res.day == 1
        assert res.hour == 12

    def test_iso_with_offset(self):
        res = parse_iso_or_epoch("2026-11-01T19:00:00+07:00")
        assert res is not None
        assert res.astimezone(dt.timezone.utc).hour == 12

    def test_invalid_string(self):
        assert parse_iso_or_epoch("not-a-valid-date") is None


class TestFormatPoolCell:
    def test_none_pool(self):
        now = dt.datetime.now(dt.timezone.utc)
        text, frac = format_pool_cell(None, now)
        assert "Không có" in text
        assert frac == -1.0

    def test_replenished_past_reset_time(self):
        now = dt.datetime.now(dt.timezone.utc)
        past_reset = (now - dt.timedelta(minutes=10)).isoformat()
        pool = {
            "remaining_fraction": 0.1,
            "reset_time": past_reset,
        }
        text, frac = format_pool_cell(pool, now)
        assert "100%" in text
        assert "Đã hồi đầy" in text
        assert frac == 1.0

    def test_healthy_quota(self):
        now = dt.datetime.now(dt.timezone.utc)
        future_reset = (now + dt.timedelta(hours=2, minutes=30)).isoformat()
        pool = {
            "remaining_fraction": 0.85,
            "reset_time": future_reset,
        }
        text, frac = format_pool_cell(pool, now)
        assert "🟢" in text
        assert "85%" in text
        assert "hồi sau" in text
        assert frac == 0.85

    def test_warning_quota(self):
        now = dt.datetime.now(dt.timezone.utc)
        pool = {
            "remaining_fraction": 0.35,
            "reset_time": None,
        }
        text, frac = format_pool_cell(pool, now)
        assert "🟡" in text
        assert "35%" in text
        assert frac == 0.35

    def test_critical_quota(self):
        now = dt.datetime.now(dt.timezone.utc)
        pool = {
            "remaining_fraction": 0.05,
            "reset_time": None,
        }
        text, frac = format_pool_cell(pool, now)
        assert "🔴" in text
        assert "5%" in text
        assert frac == 0.05


class TestSnapshotStorage:
    def test_save_and_load(self, tmp_path: Path):
        test_file = tmp_path / "test_snapshots.json"
        with patch("bin.quota_tracker.SNAPSHOT_FILE", test_file):
            # Initially empty
            data = load_snapshots()
            assert data == {"accounts": {}}

            # Save snapshot
            sample = {
                "accounts": {
                    "test@example.com": {
                        "email": "test@example.com",
                        "plan": "Pro",
                        "pools": {},
                    }
                }
            }
            save_snapshots(sample)
            assert test_file.exists()

            # Check permissions (0600 = 384 decimal)
            mode = test_file.stat().st_mode & 0o777
            assert mode == 0o600

            # Load snapshot
            loaded = load_snapshots()
            assert "test@example.com" in loaded["accounts"]


class TestCliExecution:
    def test_cli_help(self):
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "bin" / "quota_tracker.py"), "--help"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "Antigravity Multi-Account Quota Tracker" in result.stdout
        assert "--full" in result.stdout
        assert "--json" in result.stdout
