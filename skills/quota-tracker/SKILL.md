---
name: quota-tracker
description: View, monitor, and compare AI model quotas across multiple Antigravity Pro accounts with offline replenishment countdowns and switch recommendations. Triggered by requests like "kiểm tra quota", "xem quota", "check quota", "quota tracker", or asking which account to switch to.
---

# Antigravity Quota Tracker & Cache

This skill enables the agent to inspect the local multi-account quota cache, display current remaining limits for both active and offline accounts, and provide switch recommendations.

## When to Use

Activate this skill when the user:
- Asks about their current quota or usage limits.
- Asks about other logged-out or saved accounts.
- Asks which account has replenished and is ready for use.
- Types `/quota` or asks to run the quota dashboard.

## Procedure

1. Run the local tracker command to get the latest snapshot and table:
   ```bash
   python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py
   ```
   Or query raw JSON if programmatic parsing is needed:
   ```bash
   python3 ~/.gemini/config/plugins/quota-cache/bin/quota_tracker.py --json
   ```

2. Present the results directly to the user in a clean Markdown table with:
   - Account Email
   - Status (`🔵 ACTIVE`, `🟢 SẴN SÀNG`, `🟡 CÒN ÍT`, `⏳ ĐANG HỒI`)
   - Gemini 5h remaining % and replenishment ETA
   - Claude / GPT 5h remaining % and replenishment ETA
   - Recommendation for which account to switch to if the active account is exhausted.

3. Remind the user:
   - Switching accounts is done directly in the Antigravity Desktop UI.
   - Once switched, the plugin's lifecycle hook will automatically capture the new account's quota on the next prompt.
