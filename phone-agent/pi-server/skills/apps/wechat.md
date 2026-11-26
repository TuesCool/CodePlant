---
name: 微信半自动交互与风控
package: com.tencent.mm
triggers: 微信, 回复微信, 打视频, 视频通话
---

## 安全与风控规范
1. **消息获取**：优先调用 `phone_get_notifications(packageName="com.tencent.mm")` 获取近期通知栏消息，不要无故反复点进微信刷屏。
2. **回复策略**：
   - 若联系人命中 `safety-policy.json` 中的 `replyWhitelist`，可自动完成打开微信、搜索联系人并填写/发送简短确认消息；
   - 未命中白名单时，只总结内容并在对话区给出建议草稿，等待用户确认后再发送。
3. **打视频通话（强二次确认）**：
   - 调用 `phone_tap` 点击“视频通话”按钮时，必须在 `purpose` 参数明确写明 `"微信打视频给 <联系人>"`，触发 `SafetyGuard` 二次确认弹窗（Web 端 + 手机原生通知均可点允许/拒绝）。
   - 用户拒绝或超时未确认时，立即停止后续点击。
