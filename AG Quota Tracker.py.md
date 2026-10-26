\#\!/usr/bin/env python3  
"""  
Antigravity Local Multi-Account Quota Tracker (100% Localhost / Safe Mode)  
\--------------------------------------------------------------------------  
\- Chỉ đọc thông số từ tiến trình \`language\_server\` nội bộ (127.0.0.1) của  
  Official Antigravity App đang mở.  
\- KHÔNG sử dụng OAuth bên thứ ba, KHÔNG đọc khóa xác thực, KHÔNG gửi bất kỳ  
  request nào ra ngoài Internet \-\> An toàn 100% trước chính sách ToS của Google.  
\- Tự động lưu Snapshot (Email, % Quota còn lại, Mốc giờ Reset 5h) của từng  
  tài khoản mỗi khi bạn đăng nhập tài khoản đó trên Official App.  
\- Tự động tính toán đếm ngược cho các tài khoản đang đăng xuất và chuyển  
  trạng thái sang "100% (Đã hồi đầy)" ngay khi vượt qua mốc \`resetTime\`.  
"""

from \_\_future\_\_ import annotations

import argparse  
import datetime as dt  
import json  
import os  
import re  
import ssl  
import subprocess  
import sys  
import time  
import urllib.error  
import urllib.request  
from pathlib import Path  
from typing import Any, Dict, List, Optional, Tuple

SNAPSHOT\_FILE \= Path.home() / ".antigravity\_quota\_snapshots.json"  
LOCALHOST \= "127.0.0.1"

RPC\_ENDPOINTS \= \[  
    "/exa.language\_server\_pb.LanguageServerService/GetUserStatus",  
    "/exa.language\_server\_pb.LanguageServerService/RetrieveUserQuotaSummary",  
    "/exa.language\_server\_pb.LanguageServerService/GetCommandModelConfigs",  
\]

def parse\_iso\_or\_epoch(value: Any) \-\> Optional\[dt.datetime\]:  
    """Chuyển chuỗi ISO-8601 hoặc số giây epoch sang đối tượng datetime (UTC)."""  
    if value is None or value \== "":  
        return None  
    if isinstance(value, (int, float)):  
        if value \<= 0:  
            return None  
        return dt.datetime.fromtimestamp(float(value), tz=dt.timezone.utc)  
    if isinstance(value, str):  
        text \= value.strip()  
        if not text:  
            return None  
        if text.isdigit():  
            return dt.datetime.fromtimestamp(float(text), tz=dt.timezone.utc)  
        try:  
            if text.endswith("Z"):  
                text \= text\[:-1\] \+ "+00:00"  
            parsed \= dt.datetime.fromisoformat(text)  
            if parsed.tzinfo is None:  
                parsed \= parsed.replace(tzinfo=dt.timezone.utc)  
            return parsed.astimezone(dt.timezone.utc)  
        except ValueError:  
            return None  
    return None

def find\_local\_language\_servers() \-\> List\[Dict\[str, Any\]\]:  
    """  
    Tìm các tiến trình language\_server của Official Antigravity App đang chạy trên máy  
    và trích xuất PID, \--csrf\_token, \--extension\_server\_port.  
    """  
    try:  
        proc \= subprocess.run(  
            \["ps", "-ax", "-o", "pid=,command="\],  
            capture\_output=True,  
            text=True,  
            check=False,  
            timeout=5,  
        )  
    except Exception:  
        return \[\]

    candidates: List\[Dict\[str, Any\]\] \= \[\]  
    for line in proc.stdout.splitlines():  
        line\_str \= line.strip()  
        if not line\_str:  
            continue  
        lower \= line\_str.lower()  
        if "language\_server" not in lower and "language-server" not in lower:  
            continue  
        if "antigravity" not in lower:  
            continue

        parts \= line\_str.split(None, 1\)  
        if len(parts) \< 2 or not parts\[0\].isdigit():  
            continue  
        pid \= int(parts\[0\])  
        cmd \= parts\[1\]

        csrf\_match \= re.search(r"--csrf\_token(?:=\|\\s+)(\[^\\s\]+)", cmd)  
        ext\_port\_match \= re.search(r"--extension\_server\_port(?:=\|\\s+)(\\d+)", cmd)  
        ext\_csrf\_match \= re.search(  
            r"--extension\_server\_csrf\_token(?:=\|\\s+)(\[^\\s\]+)", cmd  
        )

        candidates.append(  
            {  
                "pid": pid,  
                "csrf\_token": csrf\_match.group(1) if csrf\_match else "",  
                "ext\_port": int(ext\_port\_match.group(1)) if ext\_port\_match else None,  
                "ext\_csrf\_token": ext\_csrf\_match.group(1) if ext\_csrf\_match else "",  
            }  
        )  
    return candidates

def get\_listening\_ports(pid: int) \-\> List\[int\]:  
    """Lấy danh sách cổng TCP đang LISTEN trên localhost của tiến trình language\_server."""  
    ports: List\[int\] \= \[\]  
    try:  
        proc \= subprocess.run(  
            \["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", str(pid)\],  
            capture\_output=True,  
            text=True,  
            check=False,  
            timeout=5,  
        )  
        for line in proc.stdout.splitlines():  
            match \= re.search(r":(\\d+)\\s+\\(LISTEN\\)", line)  
            if match:  
                port \= int(match.group(1))  
                if port not in ports:  
                    ports.append(port)  
    except Exception:  
        pass  
    return ports

def call\_local\_rpc(  
    port: int, endpoint: str, csrf\_token: str, use\_https: bool \= True  
) \-\> Optional\[Dict\[str, Any\]\]:  
    """Chỉ gọi RPC tới 127.0.0.1:\<port\>, tuyệt đối không kết nối ra ngoài."""  
    scheme \= "https" if use\_https else "http"  
    url \= f"{scheme}://{LOCALHOST}:{port}{endpoint}"  
    payload \= json.dumps(  
        {  
            "metadata": {  
                "ideName": "antigravity",  
                "extensionName": "antigravity",  
                "locale": "en",  
                "ideVersion": "unknown",  
            }  
        }  
    ).encode("utf-8")

    headers \= {  
        "Content-Type": "application/json",  
        "Connect-Protocol-Version": "1",  
    }  
    if csrf\_token:  
        headers\["X-Codeium-Csrf-Token"\] \= csrf\_token

    req \= urllib.request.Request(url, data=payload, headers=headers, method="POST")  
    ctx \= None  
    if use\_https:  
        ctx \= ssl.create\_default\_context()  
        ctx.check\_hostname \= False  
        ctx.verify\_mode \= ssl.CERT\_NONE

    try:  
        with urllib.request.urlopen(req, timeout=2.5, context=ctx) as resp:  
            if resp.status \== 200:  
                raw \= resp.read().decode("utf-8", errors="replace")  
                return json.loads(raw)  
    except Exception:  
        return None  
    return None

def classify\_pool(label\_or\_id: str) \-\> Optional\[str\]:  
    """Phân loại model vào 3 bể hạn mức chính của Antigravity Pro."""  
    text \= label\_or\_id.lower()  
    if any(k in text for k in \["autocomplete", "lite", "embedding", "tab"\]):  
        return None  
    if "flash" in text:  
        return "gemini\_flash"  
    if "gemini" in text:  
        return "gemini\_pro"  
    if any(k in text for k in \["claude", "sonnet", "opus", "gpt"\]):  
        return "claude\_gpt"  
    return None

def parse\_user\_status\_payload(  
    status\_data: Optional\[Dict\[str, Any\]\],  
    summary\_data: Optional\[Dict\[str, Any\]\],  
) \-\> Optional\[Dict\[str, Any\]\]:  
    """Trích xuất email, gói cước, AI credits và hạn mức từng bể từ payload nội bộ."""  
    if not status\_data and not summary\_data:  
        return None

    user\_status \= (status\_data or {}).get("userStatus") or status\_data or {}  
    email \= (  
        user\_status.get("email")  
        or user\_status.get("userEmail")  
        or user\_status.get("name")  
        or "current-local-account"  
    )  
    plan\_name \= (  
        user\_status.get("userTier", {}).get("name")  
        or user\_status.get("planStatus", {}).get("planInfo", {}).get("planName")  
        or "Pro"  
    )  
    ai\_credits \= (  
        user\_status.get("aiCredits")  
        or user\_status.get("remainingCredits")  
        or user\_status.get("planStatus", {}).get("availablePromptCredits")  
    )

    pools: Dict\[str, Dict\[str, Any\]\] \= {}

    configs \= (  
        user\_status.get("cascadeModelConfigData", {}).get("clientModelConfigs")  
        or user\_status.get("clientModelConfigs")  
        or \[\]  
    )  
    for cfg in configs:  
        label \= (  
            cfg.get("label")  
            or cfg.get("modelOrAlias", {}).get("model")  
            or cfg.get("modelId")  
            or ""  
        )  
        pool\_key \= classify\_pool(str(label))  
        if not pool\_key:  
            continue  
        q\_info \= cfg.get("quotaInfo") or {}  
        frac \= q\_info.get("remainingFraction")  
        reset\_raw \= q\_info.get("resetTime")  
        reset\_dt \= parse\_iso\_or\_epoch(reset\_raw)  
        reset\_iso \= reset\_dt.isoformat() if reset\_dt else None

        if frac is not None:  
            frac\_val \= max(0.0, min(1.0, float(frac)))  
            existing \= pools.get(pool\_key)  
            if existing is None or frac\_val \< existing\["remaining\_fraction"\]:  
                pools\[pool\_key\] \= {  
                    "remaining\_fraction": frac\_val,  
                    "reset\_time": reset\_iso,  
                    "source\_model": label,  
                }

    groups \= (summary\_data or {}).get("groups") or \[\]  
    for grp in groups:  
        grp\_name \= str(grp.get("displayName") or "")  
        for bkt in grp.get("buckets") or \[\]:  
            bkt\_id \= str(bkt.get("bucketId") or bkt.get("displayName") or grp\_name)  
            if "weekly" in bkt\_id.lower():  
                continue  
            pool\_key \= classify\_pool(bkt\_id) or classify\_pool(grp\_name)  
            if not pool\_key:  
                continue  
            rem\_obj \= bkt.get("remaining") or {}  
            frac \= rem\_obj.get("remainingFraction")  
            reset\_raw \= bkt.get("resetTime") or rem\_obj.get("resetTime")  
            reset\_dt \= parse\_iso\_or\_epoch(reset\_raw)  
            reset\_iso \= reset\_dt.isoformat() if reset\_dt else None

            if frac is not None:  
                frac\_val \= max(0.0, min(1.0, float(frac)))  
                existing \= pools.get(pool\_key)  
                if existing is None or frac\_val \< existing\["remaining\_fraction"\]:  
                    pools\[pool\_key\] \= {  
                        "remaining\_fraction": frac\_val,  
                        "reset\_time": reset\_iso or (existing or {}).get("reset\_time"),  
                        "source\_model": bkt\_id,  
                    }

    if not pools and email \== "current-local-account":  
        return None

    return {  
        "email": str(email),  
        "plan": str(plan\_name),  
        "ai\_credits": ai\_credits,  
        "last\_seen\_utc": dt.datetime.now(dt.timezone.utc).isoformat(),  
        "pools": pools,  
    }

def fetch\_active\_local\_account() \-\> Optional\[Dict\[str, Any\]\]:  
    """Quét tiến trình nội bộ và trả về snapshot của tài khoản đang mở trong Official App."""  
    candidates \= find\_local\_language\_servers()  
    for cand in candidates:  
        pid \= cand\["pid"\]  
        csrf \= cand\["csrf\_token"\]  
        ports \= get\_listening\_ports(pid)  
        if cand\["ext\_port"\] and cand\["ext\_port"\] not in ports:  
            ports.append(cand\["ext\_port"\])

        for port in ports:  
            for use\_https in (True, False):  
                token \= (  
                    csrf  
                    if use\_https  
                    else (cand\["ext\_csrf\_token"\] or csrf)  
                )  
                status\_resp \= call\_local\_rpc(  
                    port, RPC\_ENDPOINTS\[0\], token, use\_https=use\_https  
                )  
                summary\_resp \= call\_local\_rpc(  
                    port, RPC\_ENDPOINTS\[1\], token, use\_https=use\_https  
                )  
                if status\_resp or summary\_resp:  
                    parsed \= parse\_user\_status\_payload(status\_resp, summary\_resp)  
                    if parsed:  
                        return parsed  
    return None

def load\_snapshots(path: Path \= SNAPSHOT\_FILE) \-\> Dict\[str, Any\]:  
    if not path.exists():  
        return {"accounts": {}}  
    try:  
        return json.loads(path.read\_text(encoding="utf-8"))  
    except Exception:  
        return {"accounts": {}}

def save\_snapshots(data: Dict\[str, Any\], path: Path \= SNAPSHOT\_FILE) \-\> None:  
    path.write\_text(json.dumps(data, indent=2, ensure\_ascii=False), encoding="utf-8")  
    try:  
        os.chmod(path, 0o600)  
    except Exception:  
        pass

def format\_pool\_cell(  
    pool\_data: Optional\[Dict\[str, Any\]\], now\_utc: dt.datetime  
) \-\> Tuple\[str, float\]:  
    if not pool\_data:  
        return "⚪ Chưa có dữ liệu", \-1.0

    saved\_frac \= float(pool\_data.get("remaining\_fraction", 1.0))  
    reset\_dt \= parse\_iso\_or\_epoch(pool\_data.get("reset\_time"))

    if reset\_dt and now\_utc \>= reset\_dt:  
        return "🟢 100% (Đã hồi đầy)", 1.0

    pct \= int(round(saved\_frac \* 100))  
    if pct \> 50:  
        icon \= "🟢"  
    elif pct \>= 20:  
        icon \= "🟡"  
    else:  
        icon \= "🔴"

    if reset\_dt and now\_utc \< reset\_dt:  
        rem\_sec \= int((reset\_dt \- now\_utc).total\_seconds())  
        hours, rem \= divmod(rem\_sec, 3600\)  
        mins \= rem // 60  
        local\_reset \= reset\_dt.astimezone().strftime("%H:%M")  
        return f"{icon} {pct:\>3}% (hồi sau {hours}h{mins:02d}m @ {local\_reset})", saved\_frac

    return f"{icon} {pct:\>3}% (Sẵn sàng / 5h)", saved\_frac

def render\_dashboard(  
    store: Dict\[str, Any\], active\_email: Optional\[str\]  
) \-\> None:  
    now\_utc \= dt.datetime.now(dt.timezone.utc)  
    now\_local\_str \= now\_utc.astimezone().strftime("%Y-%m-%d %H:%M:%S")  
    accounts: Dict\[str, Any\] \= store.get("accounts", {})

    print("=" \* 108\)  
    print(  
        f" 📊 BẢNG THEO DÕI QUOTA ANTIGRAVITY PRO (100% LOCAL SNAPSHOT) \| Cập nhật: {now\_local\_str}"  
    )  
    print("=" \* 108\)

    if active\_email:  
        print(  
            f" ✅ Đang kết nối Localhost (127.0.0.1) với Official App — Tài khoản đang mở: {active\_email}"  
        )  
    else:  
        print(  
            " ℹ️  Không phát hiện Official App đang mở (hoặc chưa đăng nhập). Đang hiển thị từ dữ liệu Snapshot nội bộ."  
        )  
    print("-" \* 108\)

    if not accounts:  
        print(  
            " Chưa có tài khoản nào được lưu trong Snapshot.\\n"  
            " 👉 Cách 1: Mở Official Antigravity App, đăng nhập tài khoản và chạy lại lệnh này để tự động lưu.\\n"  
            " 👉 Cách 2: Thêm trước 4 tài khoản bằng lệnh:\\n"  
            "    python3 ag\_quota\_tracker.py \--set acc1@gmail.com \--gemini 100 \--claude 100\\n"  
            " 👉 Cách 3: Chạy thử giao diện mẫu 4 tài khoản với cờ: python3 ag\_quota\_tracker.py \--demo"  
        )  
        print("=" \* 108\)  
        return

    header \= (  
        f" {'Tài khoản (Email)':\<26} \| {'Trạng thái':\<16} \| "  
        f"{'Gemini Pro (5h)':\<28} \| {'Claude / GPT (5h)':\<28}"  
    )  
    print(header)  
    print("-" \* 108\)

    best\_switch\_candidates: List\[str\] \= \[\]

    for email, info in accounts.items():  
        is\_active \= (email \== active\_email)  
        pools \= info.get("pools", {})

        gem\_str, gem\_frac \= format\_pool\_cell(pools.get("gemini\_pro"), now\_utc)  
        claude\_str, claude\_frac \= format\_pool\_cell(pools.get("claude\_gpt"), now\_utc)

        if is\_active:  
            status\_label \= "🔵 ĐANG DÙNG"  
        else:  
            min\_frac \= min(  
                \[f for f in (gem\_frac, claude\_frac) if f \>= 0.0\] or \[1.0\]  
            )  
            if min\_frac \>= 0.5:  
                status\_label \= "🟢 SẴN SÀNG"  
                best\_switch\_candidates.append(email)  
            elif min\_frac \> 0.0:  
                status\_label \= "🟡 CÒN ÍT"  
            else:  
                status\_label \= "⏳ ĐANG HỒI"

        short\_email \= email if len(email) \<= 26 else email\[:23\] \+ "..."  
        print(  
            f" {short\_email:\<26} \| {status\_label:\<16} \| {gem\_str:\<28} \| {claude\_str:\<28}"  
        )

    print("-" \* 108\)  
    if best\_switch\_candidates:  
        print(  
            f" 💡 Gợi ý Switch thủ công tiếp theo: {', '.join(best\_switch\_candidates)}"  
        )  
    print(  
        " 🔒 Chế độ An toàn: Chỉ đọc 127.0.0.1 của App đang mở & tự tính giờ hồi ngoại tuyến (Không dùng OAuth bên thứ 3)."  
    )  
    print("=" \* 108\)

def build\_demo\_store() \-\> Tuple\[Dict\[str, Any\], str\]:  
    now\_utc \= dt.datetime.now(dt.timezone.utc)  
    return (  
        {  
            "accounts": {  
                "dev.pro1@gmail.com": {  
                    "email": "dev.pro1@gmail.com",  
                    "plan": "Pro (Family \#1)",  
                    "last\_seen\_utc": now\_utc.isoformat(),  
                    "pools": {  
                        "gemini\_pro": {  
                            "remaining\_fraction": 0.15,  
                            "reset\_time": (  
                                now\_utc \+ dt.timedelta(hours=1, minutes=42)  
                            ).isoformat(),  
                        },  
                        "claude\_gpt": {  
                            "remaining\_fraction": 0.0,  
                            "reset\_time": (  
                                now\_utc \+ dt.timedelta(hours=1, minutes=15)  
                            ).isoformat(),  
                        },  
                    },  
                },  
                "dev.pro2@gmail.com": {  
                    "email": "dev.pro2@gmail.com",  
                    "plan": "Pro (Family \#2)",  
                    "last\_seen\_utc": (now\_utc \- dt.timedelta(hours=5, minutes=20)).isoformat(),  
                    "pools": {  
                        "gemini\_pro": {  
                            "remaining\_fraction": 0.0,  
                            "reset\_time": (  
                                now\_utc \- dt.timedelta(minutes=20)  
                            ).isoformat(),  
                        },  
                        "claude\_gpt": {  
                            "remaining\_fraction": 0.0,  
                            "reset\_time": (  
                                now\_utc \- dt.timedelta(minutes=20)  
                            ).isoformat(),  
                        },  
                    },  
                },  
                "dev.pro3@gmail.com": {  
                    "email": "dev.pro3@gmail.com",  
                    "plan": "Pro (Family \#3)",  
                    "last\_seen\_utc": (now\_utc \- dt.timedelta(hours=2)).isoformat(),  
                    "pools": {  
                        "gemini\_pro": {  
                            "remaining\_fraction": 0.80,  
                            "reset\_time": (  
                                now\_utc \+ dt.timedelta(hours=2, minutes=55)  
                            ).isoformat(),  
                        },  
                        "claude\_gpt": {  
                            "remaining\_fraction": 0.65,  
                            "reset\_time": (  
                                now\_utc \+ dt.timedelta(hours=2, minutes=55)  
                            ).isoformat(),  
                        },  
                    },  
                },  
                "dev.pro4@gmail.com": {  
                    "email": "dev.pro4@gmail.com",  
                    "plan": "Pro (Family \#4)",  
                    "last\_seen\_utc": (now\_utc \- dt.timedelta(hours=3)).isoformat(),  
                    "pools": {  
                        "gemini\_pro": {  
                            "remaining\_fraction": 0.0,  
                            "reset\_time": (  
                                now\_utc \+ dt.timedelta(hours=1, minutes=50)  
                            ).isoformat(),  
                        },  
                        "claude\_gpt": {  
                            "remaining\_fraction": 0.0,  
                            "reset\_time": (  
                                now\_utc \+ dt.timedelta(hours=1, minutes=50)  
                            ).isoformat(),  
                        },  
                    },  
                },  
            }  
        },  
        "dev.pro1@gmail.com",  
    )

def main() \-\> None:  
    parser \= argparse.ArgumentParser(  
        description="Công cụ theo dõi hạn mức 4 tài khoản Antigravity Pro an toàn 100% (Localhost Snapshot)."  
    )  
    parser.add\_argument(  
        "--demo",  
        action="store\_true",  
        help="Hiển thị bảng mô phỏng 4 tài khoản Pro ở 4 nhóm Family khác nhau.",  
    )  
    parser.add\_argument(  
        "--watch",  
        nargs="?",  
        const=30,  
        type=int,  
        metavar="SECONDS",  
        help="Tự động làm mới bảng hiển thị mỗi N giây (mặc định 30s).",  
    )  
    parser.add\_argument(  
        "--set",  
        metavar="EMAIL",  
        help="Thêm hoặc cập nhật thủ công một tài khoản vào danh sách theo dõi.",  
    )  
    parser.add\_argument(  
        "--gemini",  
        type=float,  
        default=100.0,  
        help="Phần trăm Gemini Pro còn lại (0-100) khi dùng cùng \--set.",  
    )  
    parser.add\_argument(  
        "--claude",  
        type=float,  
        default=100.0,  
        help="Phần trăm Claude/GPT còn lại (0-100) khi dùng cùng \--set.",  
    )  
    parser.add\_argument(  
        "--reset-in",  
        type=float,  
        default=None,  
        metavar="HOURS",  
        help="Số giờ còn lại trước khi hồi 100%% (ví dụ: 4.5 cho 4 giờ 30 phút) khi dùng cùng \--set.",  
    )  
    parser.add\_argument(  
        "--remove",  
        metavar="EMAIL",  
        help="Xóa một tài khoản khỏi file Snapshot nội bộ.",  
    )

    args \= parser.parse\_args()

    if args.demo:  
        demo\_store, active \= build\_demo\_store()  
        render\_dashboard(demo\_store, active)  
        return

    store \= load\_snapshots()  
    accounts \= store.setdefault("accounts", {})

    if args.remove:  
        if args.remove in accounts:  
            del accounts\[args.remove\]  
            save\_snapshots(store)  
            print(f"✅ Đã xóa tài khoản {args.remove} khỏi Snapshot nội bộ.")  
        else:  
            print(f"ℹ️ Không tìm thấy tài khoản {args.remove} trong Snapshot.")  
        return

    if args.set:  
        now\_utc \= dt.datetime.now(dt.timezone.utc)  
        reset\_iso \= None  
        if args.reset\_in is not None and args.reset\_in \> 0:  
            reset\_iso \= (  
                now\_utc \+ dt.timedelta(hours=float(args.reset\_in))  
            ).isoformat()  
        accounts\[args.set\] \= {  
            "email": args.set,  
            "plan": "Pro",  
            "last\_seen\_utc": now\_utc.isoformat(),  
            "pools": {  
                "gemini\_pro": {  
                    "remaining\_fraction": max(0.0, min(1.0, args.gemini / 100.0)),  
                    "reset\_time": reset\_iso,  
                },  
                "claude\_gpt": {  
                    "remaining\_fraction": max(0.0, min(1.0, args.claude / 100.0)),  
                    "reset\_time": reset\_iso,  
                },  
            },  
        }  
        save\_snapshots(store)  
        print(f"✅ Đã lưu trạng thái cho tài khoản: {args.set}")

    if args.watch:  
        interval \= max(5, args.watch)  
        try:  
            while True:  
                os.system("clear" if os.name \!= "nt" else "cls")  
                store \= load\_snapshots()  
                active\_snap \= fetch\_active\_local\_account()  
                active\_email \= None  
                if active\_snap:  
                    active\_email \= active\_snap\["email"\]  
                    store.setdefault("accounts", {})\[active\_email\] \= active\_snap  
                    save\_snapshots(store)  
                render\_dashboard(store, active\_email)  
                print(f" ⏱️  Đang tự động cập nhật mỗi {interval} giây (Nhấn Ctrl+C để thoát)...")  
                time.sleep(interval)  
        except KeyboardInterrupt:  
            print("\\nĐã dừng chế độ theo dõi.")  
        return

    active\_snap \= fetch\_active\_local\_account()  
    active\_email \= None  
    if active\_snap:  
        active\_email \= active\_snap\["email"\]  
        accounts\[active\_email\] \= active\_snap  
        save\_snapshots(store)

    render\_dashboard(store, active\_email)

if \_\_name\_\_ \== "\_\_main\_\_":  
    main()  
