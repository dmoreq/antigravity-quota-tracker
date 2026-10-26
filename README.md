# Antigravity Quota Cache & Multi-Account Tracker Plugin

Một plugin chính thức theo kiến trúc Antigravity Customization System (hỗ trợ Antigravity 2.0 và CLI), giúp tự động lưu cache thông tin hạn mức (Quota) của nhiều tài khoản khi bạn chuyển đổi qua lại giữa các account trên Official Antigravity Desktop App.

---

## 🌟 Tính năng nổi bật

1. **Giao diện Auxiliary Side Pane trực quan**:
   - Tích hợp trực tiếp vào thanh bên (Aux Pane) của Antigravity Desktop qua giao thức `sidecar://quota-cache/quota-ui/`.
   - **Nhóm theo Model Category**:
     - ✨ **Gemini Models** (Gemini Pro / Flash)
     - ⚡ **Argon Models** (Gemini 4 Argon)
     - 🧠 **Claude Models** (Claude Opus, Sonnet, GPT-OSS)
   - **Hiển thị song song**: Trong mỗi model group, từng tài khoản hiển thị cả cột **5-Hour Limit** và **Weekly Limit** trên cùng một hàng.
   - **Live Countdown Ticker**: Bộ đếm ngược thời gian hồi (ETA) nhảy mượt mà từng giây theo giờ địa phương mà không cần reload trang.
   - **Tự động làm mới**: Tự động poll dữ liệu ngầm mỗi 15 giây.

2. **Tự động Snapshot qua Lifecycle Hooks (`hooks.json`)**:
   - Tự động chạy mỗi khi bạn mở phiên chat (`SessionStart`) hoặc khi agent kết thúc lượt trả lời (`Stop`).
   - Kết nối trực tiếp qua RPC nội bộ `127.0.0.1` của Official Desktop App (`GetUserStatus` & `RetrieveUserQuotaSummary`).
   - Tự động lưu và cập nhật tài khoản đang active vào file snapshot `~/.antigravity_quota_snapshots.json`.

3. **Tính toán giờ hồi ngoại tuyến (Offline Replenishment Countdown)**:
   - Khi bạn chuyển sang tài khoản khác, tài khoản cũ vẫn được lưu trong cache.
   - Tự động chuyển trạng thái thành `🟢 100% (Đã hồi đầy)` ngay khi vượt qua mốc giờ reset mà không cần phải đăng nhập lại.

4. **An toàn 100% (Safe & Localhost Only)**:
   - Tuyệt đối KHÔNG đọc token xác thực, KHÔNG đọc Keychain hay lưu mật khẩu.
   - Tuyệt đối KHÔNG gửi bất kỳ request nào ra ngoài Internet.
   - File snapshot được phân quyền bảo mật `0600` (chỉ user hiện tại có quyền đọc/ghi).

5. **Skill tích hợp sẵn cho Agent (`quota-tracker`)**:
   - Bạn chỉ cần hỏi agent: *"Xem quota hiện tại"*, *"Account nào đã hồi?"*, hoặc gõ `/quota`, agent sẽ tự động hiển thị bảng so sánh trực quan.

---

## 📂 Cấu trúc Plugin

```text
quota-cache/
├── plugin.json                 # Khai báo plugin metadata cho Antigravity
├── hooks.json                  # Lifecycle hooks (SessionStart & Stop)
├── hooks/
│   └── record_snapshot.py      # Script ghi nhận snapshot tự động qua Localhost RPC
├── skills/
│   └── quota-tracker/
│       └── SKILL.md            # Skill hướng dẫn Agent tra cứu và gợi ý account switch
├── sidecars/
│   └── quota-ui/               # Auxiliary Side Pane Web UI
│       ├── sidecar.json        # Đăng ký view SIDECAR_UI_ENTRYPOINT_AUX_PANE
│       ├── server.cjs          # Node.js HTTP backend (thuần stdlib)
│       ├── index.html          # HTML dashboard
│       ├── app.js              # Logic render theo Category & live countdown
│       └── styles.css          # Theme-aware CSS (VS Code tokens)
├── bin/
│   └── quota_tracker.py        # CLI Dashboard xem quota trực tiếp trong Terminal
└── README.md
```

---

## 🚀 Cài đặt & Kích hoạt

### Liên kết plugin vào Antigravity

```bash
mkdir -p ~/.gemini/config/plugins
ln -sfn "/Users/quy.doan/Workspace/personal/agy-quotas" ~/.gemini/config/plugins/quota-cache
```

---

## 💻 Sử dụng

### 1. Mở giao diện trên thanh bên (Auxiliary Side Pane)
Bấm vào link sau trong khung chat:
> [Mở Quota Dashboard](sidecar://quota-cache/quota-ui/)

### 2. Sử dụng CLI độc lập trong Terminal
```bash
# Xem bảng quota hiện tại của các tài khoản đã cache
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py

# Xem chi tiết toàn bộ các bể (Gemini, Claude, Argon, Weekly)
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --full

# Chế độ theo dõi tự động làm mới mỗi 15 giây
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --watch 15
```
