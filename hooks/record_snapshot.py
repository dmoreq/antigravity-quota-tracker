#!/usr/bin/env python3
"""Antigravity Lifecycle Hook: Record Quota Snapshot.

Runs on SessionStart and Stop events. Queries the active language server
over localhost RPC, extracts user status and quota summaries, and persists
a snapshot to ~/.antigravity_quota_snapshots.json.
Always outputs a valid JSON object ({}) to stdout.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SNAPSHOT_FILE = Path.home() / ".antigravity_quota_snapshots.json"


def parse_iso_or_epoch(value: Any) -> Optional[dt.datetime]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        if value <= 0:
            return None
        return dt.datetime.fromtimestamp(float(value), tz=dt.timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.isdigit():
            return dt.datetime.fromtimestamp(float(text), tz=dt.timezone.utc)
        try:
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            parsed = dt.datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed.astimezone(dt.timezone.utc)
        except ValueError:
            return None
    return None


def query_ls_rpc(address: str, csrf_token: str, method: str) -> Optional[Dict[str, Any]]:
    url = f"http://{address}/exa.language_server_pb.LanguageServerService/{method}"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={
            "Content-Type": "application/json",
            "x-codeium-csrf-token": csrf_token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw)
    except Exception:
        return None
    return None


def fallback_find_ls() -> Optional[Tuple[str, str]]:
    """Fallback scanner for language_server PID and arguments if env vars are absent."""
    try:
        proc = subprocess.run(
            ["ps", "-ax", "-o", "pid=,command="],
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
        )
    except Exception:
        return None

    for line in proc.stdout.splitlines():
        line_str = line.strip()
        if "language_server" not in line_str.lower():
            continue
        parts = line_str.split(None, 1)
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        pid = int(parts[0])
        cmd = parts[1]

        csrf_match = re.search(r"--csrf_token(?:=|\s+)([^\s]+)", cmd)
        csrf = csrf_match.group(1) if csrf_match else ""

        try:
            lsof_proc = subprocess.run(
                ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", str(pid)],
                capture_output=True,
                text=True,
                check=False,
                timeout=3,
            )
            for lsof_line in lsof_proc.stdout.splitlines():
                port_match = re.search(r":(\d+)\s+\(LISTEN\)", lsof_line)
                if port_match:
                    port = port_match.group(1)
                    return f"127.0.0.1:{port}", csrf
        except Exception:
            continue
    return None


def extract_snapshot(
    raw_status: Optional[Dict[str, Any]],
    raw_summary: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    user_status = (raw_status or {}).get("userStatus") or raw_status or {}
    email = user_status.get("email") or user_status.get("name")
    if not email:
        return None

    plan = (
        user_status.get("userTier", {}).get("name")
        or user_status.get("planStatus", {}).get("planInfo", {}).get("planName")
        or "Pro"
    )

    pools: Dict[str, Dict[str, Any]] = {}

    # Extract from RetrieveUserQuotaSummary groups
    groups = (raw_summary or {}).get("response", {}).get("groups") or (raw_summary or {}).get("groups") or []
    for grp in groups:
        grp_name = str(grp.get("displayName") or "").lower()
        for bkt in grp.get("buckets", []):
            bkt_id = str(bkt.get("bucketId") or "").lower()
            window = str(bkt.get("window") or "").lower()
            frac = bkt.get("remainingFraction")
            reset_dt = parse_iso_or_epoch(bkt.get("resetTime"))
            reset_iso = reset_dt.isoformat() if reset_dt else None

            if "claude" in grp_name or "3p" in bkt_id:
                key = "claude_5h" if ("5h" in window or "5h" in bkt_id) else "claude_weekly"
            elif "argon" in grp_name or "argon" in bkt_id:
                key = "argon_weekly"
            elif "gemini" in grp_name:
                key = "gemini_5h" if ("5h" in window or "5h" in bkt_id) else "gemini_weekly"
            else:
                key = bkt_id or grp_name

            if frac is not None:
                pools[key] = {
                    "remaining_fraction": max(0.0, min(1.0, float(frac))),
                    "reset_time": reset_iso,
                    "display_name": bkt.get("displayName") or grp.get("displayName"),
                    "window": window or ("5h" if "5h" in key else "weekly"),
                }

    # Fallback to cascadeModelConfigData if summary groups are empty
    if not pools:
        configs = (
            user_status.get("cascadeModelConfigData", {}).get("clientModelConfigs")
            or user_status.get("clientModelConfigs")
            or []
        )
        for cfg in configs:
            label = cfg.get("label") or cfg.get("modelOrAlias", {}).get("model") or ""
            lbl_lower = str(label).lower()
            if any(k in lbl_lower for k in ["autocomplete", "lite", "embedding", "tab"]):
                continue

            if "claude" in lbl_lower or "sonnet" in lbl_lower or "opus" in lbl_lower:
                key = "claude_5h"
            elif "argon" in lbl_lower:
                key = "argon_weekly"
            elif "flash" in lbl_lower:
                key = "gemini_flash"
            elif "gemini" in lbl_lower:
                key = "gemini_5h"
            else:
                continue

            q = cfg.get("quotaInfo") or {}
            frac = q.get("remainingFraction")
            reset_dt = parse_iso_or_epoch(q.get("resetTime"))
            frac_val = max(0.0, min(1.0, float(frac))) if frac is not None else 0.0

            existing = pools.get(key)
            if existing is None or frac_val < existing["remaining_fraction"]:
                pools[key] = {
                    "remaining_fraction": frac_val,
                    "reset_time": reset_dt.isoformat() if reset_dt else None,
                    "display_name": label,
                    "window": "5h" if "5h" in key else "weekly",
                }

    now_utc = dt.datetime.now(dt.timezone.utc)
    return {
        "email": str(email),
        "plan": str(plan),
        "last_seen_utc": now_utc.isoformat(),
        "pools": pools,
    }


def record_current_snapshot() -> None:
    address = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")

    if not address or not csrf:
        fallback = fallback_find_ls()
        if fallback:
            address, csrf = fallback

    if not address or not csrf:
        return

    status_data = query_ls_rpc(address, csrf, "GetUserStatus")
    summary_data = query_ls_rpc(address, csrf, "RetrieveUserQuotaSummary")

    if not status_data and not summary_data:
        return

    snapshot = extract_snapshot(status_data, summary_data)
    if not snapshot:
        return

    email = snapshot["email"]

    store: Dict[str, Any] = {"accounts": {}}
    if SNAPSHOT_FILE.exists():
        try:
            store = json.loads(SNAPSHOT_FILE.read_text(encoding="utf-8"))
        except Exception:
            store = {"accounts": {}}

    store.setdefault("accounts", {})[email] = snapshot

    tmp_path = SNAPSHOT_FILE.with_suffix(".tmp")
    try:
        tmp_path.write_text(
            json.dumps(store, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        os.chmod(tmp_path, 0o600)
        tmp_path.replace(SNAPSHOT_FILE)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()


def main() -> None:
    try:
        if not sys.stdin.isatty():
            _ = sys.stdin.read()
    except Exception:
        pass

    try:
        record_current_snapshot()
    except Exception:
        pass

    sys.stdout.write("{}\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
