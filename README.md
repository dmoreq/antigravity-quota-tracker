# Antigravity Quota Cache & Multi-Account Tracker Plugin

Một plugin chính thức theo kiến trúc Antigravity Customization System (hỗ trợ Antigravity 2.0 và CLI), giúp tự động lưu cache thông tin hạn mức (Quota) của nhiều tài khoản khi bạn chuyển đổi qua lại giữa các account trên Official Antigravity Desktop App.

---

## 🌟 Tính năng nổi bật

1. **Tự động Snapshot qua Lifecycle Hooks (`hooks.json`)**:
   - Tự động chạy mỗi khi bạn mở phiên chat (`SessionStart`) hoặc khi agent kết thúc lượt trả lời (`Stop`).
   - Kết nối trực tiếp qua RPC nội bộ `127.0.0.1` của Official Desktop App (`GetUserStatus` & `RetrieveUserQuotaSummary`).
   - Tự động cập nhật tài khoản đang active vào file snapshot `~/.antigravity_quota_snapshots.json`.

2. **Tính toán giờ hồi ngoại tuyến (Offline Replenishment Countdown)**:
   - Khi bạn chuyển sang tài khoản khác, tài khoản cũ vẫn được lưu trong cache.
   - Script tự động tính toán thời gian đếm ngược dựa vào mốc `resetTime` (cửa sổ 5h và weekly).
   - Tự động chuyển trạng thái thành `🟢 100% (Đã hồi đầy)` ngay khi vượt qua mốc giờ reset mà không cần phải đăng nhập lại.

3. **An toàn 100% (Safe & Localhost Only)**:
   - Tuyệt đối KHÔNG đọc token xác thực, KHÔNG đọc Keychain hay lưu mật khẩu.
   - Tuyệt đối KHÔNG gửi bất kỳ request nào ra ngoài Internet.
   - File snapshot được phân quyền bảo mật `0600` (chỉ user hiện tại có quyền đọc/ghi).

4. **Skill tích hợp sẵn cho Agent (`quota-tracker`)**:
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
├── bin/
│   └── quota_tracker.py        # CLI Dashboard xem quota trực tiếp trong Terminal
└── README.md
```

---

## 🚀 Cài đặt & Kích hoạt

### Cách 1: Tạo symlink vào thư mục plugin của Antigravity (Khuyên dùng)

```bash
mkdir -p ~/.gemini/config/plugins
ln -s "/Users/quy.doan/Workspace/personal/agy-quotas" ~/.gemini/config/plugins/quota-cache
```

### Cách 2: Copy trực tiếp

```bash
mkdir -p ~/.gemini/config/plugins/quota-cache
cp -R /Users/quy.doan/Workspace/personal/agy-quotas/* ~/.gemini/config/plugins/quota-cache/
```

*Lưu ý: Sau khi liên kết plugin lần đầu, bạn chỉ cần khởi động lại Antigravity một lần để app phát hiện plugin mới.*

---

## 💻 Sử dụng CLI độc lập

Bạn có thể chạy bảng điều khiển trực tiếp từ terminal bất kỳ lúc nào:

```bash
# Xem bảng quota hiện tại của các tài khoản đã cache
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py

# Chế độ theo dõi tự động làm mới mỗi 15 giây
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --watch 15

# Xuất dữ liệu dạng JSON
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --json

# Thêm hoặc cập nhật thủ công một tài khoản vào cache
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --set user@gmail.com --gemini 80 --claude 100

# Xóa một tài khoản khỏi cache
python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --remove user@gmail.com
```
