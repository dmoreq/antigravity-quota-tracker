#!/usr/bin/env python3
"""Antigravity Multi-Account Quota Tracker & Dashboard.

Reads snapshots from ~/.antigravity_quota_snapshots.json and live data from
localhost language_server if reachable.
Calculates offline replenishment countdowns and highlights switch recommendations.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SNAPSHOT_FILE = Path.home() / ".antigravity_quota_snapshots.json"
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


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
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            if resp.status == 200:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw)
    except Exception:
        return None
    return None


def find_active_ls() -> Optional[Tuple[str, str]]:
    addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
    if addr and csrf:
        return addr, csrf

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


def fetch_live_snapshot() -> Optional[Dict[str, Any]]:
    conn = find_active_ls()
    if not conn:
        return None
    addr, csrf = conn

    status_data = query_ls_rpc(addr, csrf, "GetUserStatus")
    summary_data = query_ls_rpc(addr, csrf, "RetrieveUserQuotaSummary")
    if not status_data and not summary_data:
        return None

    # Import extraction logic from hook
    try:
        from hooks.record_snapshot import extract_snapshot
        return extract_snapshot(status_data, summary_data)
    except ImportError:
        pass

    user_status = (status_data or {}).get("userStatus") or status_data or {}
    email = user_status.get("email") or user_status.get("name")
    if not email:
        return None

    return {
        "email": str(email),
        "plan": str(user_status.get("userTier", {}).get("name") or "Pro"),
        "last_seen_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "pools": {},
    }


def load_snapshots() -> Dict[str, Any]:
    if not SNAPSHOT_FILE.exists():
        return {"accounts": {}}
    try:
        return json.loads(SNAPSHOT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"accounts": {}}


def save_snapshots(data: Dict[str, Any]) -> None:
    tmp = SNAPSHOT_FILE.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(SNAPSHOT_FILE)
    except Exception:
        if tmp.exists():
            tmp.unlink()


def format_pool_cell(pool: Optional[Dict[str, Any]], now_utc: dt.datetime) -> Tuple[str, float]:
    if not pool:
        return "⚪ Không có", -1.0

    raw_frac = float(pool.get("remaining_fraction", 1.0))
    reset_dt = parse_iso_or_epoch(pool.get("reset_time"))

    # Replenished check
    if reset_dt and now_utc >= reset_dt:
        return "🟢 100% (Đã hồi đầy)", 1.0

    pct = int(round(raw_frac * 100))
    if pct > 50:
        icon = "🟢"
    elif pct >= 15:
        icon = "🟡"
    else:
        icon = "🔴"

    if reset_dt and now_utc < reset_dt:
        diff_sec = int((reset_dt - now_utc).total_seconds())
        hours, rem = divmod(diff_sec, 3600)
        mins = rem // 60
        local_t = reset_dt.astimezone().strftime("%H:%M")
        return f"{icon} {pct:>3}% (hồi sau {hours}h{mins:02d}m @ {local_t})", raw_frac

    return f"{icon} {pct:>3}%", raw_frac


def render_dashboard(store: Dict[str, Any], active_email: Optional[str], full: bool = False) -> None:
    now_utc = dt.datetime.now(dt.timezone.utc)
    now_str = now_utc.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    accounts = store.get("accounts", {})

    width = 112 if not full else 140
    print("=" * width)
    print(f" 📊 BẢNG THEO DÕI QUOTA ANTIGRAVITY PRO (100% LOCAL CACHE) | {now_str}")
    print("=" * width)

    if active_email:
        print(f" ✅ Đang kết nối Official App (127.0.0.1) — Account Active: {active_email}")
    else:
        print(" ℹ️  Official App không mở hoặc đang idle. Đang đọc từ cache snapshot cục bộ.")
    print("-" * width)

    if not accounts:
        print(" (Chưa có dữ liệu snapshot nào trong cache ~/.antigravity_quota_snapshots.json)")
        print("=" * width)
        return

    if not full:
        header = (
            f" {'Tài khoản (Email)':<28} | {'Trạng thái':<14} | "
            f"{'Gemini 5h':<28} | {'Claude / GPT 5h':<28}"
        )
        print(header)
        print("-" * width)
    else:
        header = (
            f" {'Tài khoản (Email)':<24} | {'Gemini 5h':<22} | "
            f"{'Claude 5h':<22} | {'Gemini Wk':<20} | {'Claude Wk':<20} | {'Argon Wk':<20}"
        )
        print(header)
        print("-" * width)

    switch_recommendations: List[str] = []

    for email, info in accounts.items():
        is_active = (email == active_email)
        pools = info.get("pools", {})

        gem_5h = pools.get("gemini_5h") or pools.get("gemini_pro")
        claude_5h = pools.get("claude_5h") or pools.get("claude_gpt")
        gem_wk = pools.get("gemini_weekly")
        claude_wk = pools.get("claude_weekly")
        argon_wk = pools.get("argon_weekly")

        gem_str, gem_frac = format_pool_cell(gem_5h, now_utc)
        claude_str, claude_frac = format_pool_cell(claude_5h, now_utc)

        if not full:
            if is_active:
                status = "🔵 ACTIVE"
            else:
                avail = [f for f in (gem_frac, claude_frac) if f >= 0.0]
                min_frac = min(avail) if avail else 1.0
                if min_frac >= 0.5:
                    status = "🟢 SẴN SÀNG"
                    switch_recommendations.append(email)
                elif min_frac > 0.05:
                    status = "🟡 CÒN ÍT"
                else:
                    status = "⏳ ĐANG HỒI"

            short_email = email if len(email) <= 28 else email[:25] + "..."
            print(f" {short_email:<28} | {status:<14} | {gem_str:<28} | {claude_str:<28}")
        else:
            tag = "🔵 " if is_active else "   "
            short_email = (tag + email) if len(tag + email) <= 24 else (tag + email)[:21] + "..."
            gem_wk_str, _ = format_pool_cell(gem_wk, now_utc)
            claude_wk_str, _ = format_pool_cell(claude_wk, now_utc)
            argon_wk_str, _ = format_pool_cell(argon_wk, now_utc)
            print(
                f" {short_email:<24} | {gem_str:<22} | {claude_str:<22} | "
                f"{gem_wk_str:<20} | {claude_wk_str:<20} | {argon_wk_str:<20}"
            )

    print("-" * width)
    if switch_recommendations:
        print(f" 💡 Gợi ý Switch tiếp theo: {', '.join(switch_recommendations)}")
    print(" 🔒 An toàn 100%: Chỉ giao tiếp với 127.0.0.1 của Antigravity; không lưu token hay mật khẩu.")
    print("=" * width)



def main() -> None:
    parser = argparse.ArgumentParser(description="Antigravity Multi-Account Quota Tracker.")
    parser.add_argument("--full", "-f", action="store_true", help="Hiển thị chi tiết toàn bộ các bể: Gemini 5h, Claude 5h, Gemini Weekly, Claude Weekly, Argon Weekly.")
    parser.add_argument("--watch", nargs="?", const=15, type=int, metavar="SEC", help="Tự động làm mới bảng mỗi SEC giây (mặc định 15s).")
    parser.add_argument("--json", action="store_true", help="Xuất toàn bộ dữ liệu cache dạng JSON.")
    parser.add_argument("--set", metavar="EMAIL", help="Thêm hoặc cập nhật thủ công một tài khoản vào cache.")
    parser.add_argument("--gemini", type=float, default=100.0, help="Phần trăm Gemini (0-100) khi dùng với --set.")
    parser.add_argument("--claude", type=float, default=100.0, help="Phần trăm Claude (0-100) khi dùng với --set.")
    parser.add_argument("--remove", metavar="EMAIL", help="Xóa một tài khoản khỏi cache.")

    args = parser.parse_args()

    store = load_snapshots()
    accounts = store.setdefault("accounts", {})

    if args.remove:
        if args.remove in accounts:
            del accounts[args.remove]
            save_snapshots(store)
            print(f"✅ Đã xóa {args.remove} khỏi cache.")
        else:
            print(f"ℹ️ Không tìm thấy {args.remove}.")
        return

    if args.set:
        now_utc = dt.datetime.now(dt.timezone.utc)
        accounts[args.set] = {
            "email": args.set,
            "plan": "Pro",
            "last_seen_utc": now_utc.isoformat(),
            "pools": {
                "gemini_5h": {"remaining_fraction": max(0.0, min(1.0, args.gemini / 100.0)), "window": "5h"},
                "claude_5h": {"remaining_fraction": max(0.0, min(1.0, args.claude / 100.0)), "window": "5h"},
            },
        }
        save_snapshots(store)
        print(f"✅ Đã lưu: {args.set}")
        return

    if args.json:
        print(json.dumps(store, indent=2, ensure_ascii=False))
        return

    # Try live fetch
    live_snap = fetch_live_snapshot()
    active_email = None
    if live_snap:
        active_email = live_snap["email"]
        accounts[active_email] = live_snap
        save_snapshots(store)

    if args.watch:
        interval = max(3, args.watch)
        try:
            while True:
                os.system("clear" if os.name != "nt" else "cls")
                store = load_snapshots()
                live_snap = fetch_live_snapshot()
                active_email = None
                if live_snap:
                    active_email = live_snap["email"]
                    store.setdefault("accounts", {})[active_email] = live_snap
                    save_snapshots(store)
                render_dashboard(store, active_email, full=args.full)
                print(f" ⏱️ Đang tự động cập nhật mỗi {interval}s (Ctrl+C để thoát)...")
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nĐã dừng chế độ theo dõi.")
            return

    render_dashboard(store, active_email, full=args.full)


if __name__ == "__main__":
    main()
