# PassVault 恢复演练手册

本手册覆盖四种常见运维场景的操作步骤，每种场景均包含操作命令、预期影响和验证方法。

---

## 场景 1：轮换 JWT_SECRET

**何时需要**：JWT_SECRET 泄露、定期安全轮换、迁移到新 secret 管理系统。

**影响分析**：

| 组件 | 影响 |
| ---- | ---- |
| Access token（1 小时 JWT） | 立即失效，用户需重新登录 |
| Refresh token（存于 D1） | **不受影响**，仍可用于获取新 access token |
| TOTP 恢复码 (`$rch$v1$`) | ⚠️ 若未设置 `RECOVERY_CODE_SECRET`，恢复码 HMAC 使用 `JWT_SECRET` 派生，**轮换后旧恢复码失效**，需要用户重新生成 |
| 备份文件 HMAC | 旧备份签名校验失败（预期行为），恢复时会告警 |

**操作步骤**：

1. 生成新 secret：
   ```bash
   openssl rand -hex 32
   ```

2. 停止服务，更新环境变量：
   ```bash
   docker stop nodewarden-passvault-1
   # 编辑 .env 或 docker-compose.yml，替换 JWT_SECRET 值
   # 若使用 RECOVERY_CODE_SECRET，可保持不变（独立轮换）
   ```

3. 重启服务：
   ```bash
   docker start nodewarden-passvault-1
   ```

4. 验证服务就绪：
   ```bash
   curl -sf http://localhost:8787/api/version
   ```

5. 若希望立即吊销所有 refresh token（强制全员重新登录）：
   ```bash
   curl -X DELETE http://localhost:8787/api/admin/sessions \
     -H "Authorization: Bearer <admin_access_token>"
   ```

6. 通知用户：已登录会话在 refresh token 使用时仍有效，但若未设 `RECOVERY_CODE_SECRET`，旧恢复码已失效，需重新生成。

**最佳实践**：设置独立的 `RECOVERY_CODE_SECRET`，使恢复码 HMAC 与 JWT 签名密钥完全分离，轮换 `JWT_SECRET` 不影响恢复码。

---

## 场景 2：跨实例恢复（从备份还原到新实例）

**何时需要**：服务迁移、灾难恢复、本地测试生产数据。

**前提条件**：
- 目标实例是**全新**部署（无 vault 数据），或已知悉全量覆盖的影响
- 已有备份文件（`.zip` 格式）

**操作步骤**：

1. 确认目标实例无数据（否则 import 会报错）：
   ```bash
   curl -sf http://localhost:8787/api/version
   ```

2. 通过管理员后台上传备份文件：
   - 路径：管理员 → 备份 → 导入备份
   - 或 API：`POST /api/admin/backup/import`（multipart/form-data，字段名 `file`）

3. **HMAC 签名不匹配**：跨实例恢复时，备份文件的 `manifest.integrity.dbHmac` 是源实例 `JWT_SECRET` 签名的，目标实例 `JWT_SECRET` 不同，校验**必然失败**。
   - 首次安装（空实例）：系统会**阻断导入**，需要通过管理后台确认这是预期的跨实例操作后继续。
   - 覆盖恢复（已有数据）：仅告警，继续导入。

4. **TOTP 恢复码自动重置**：跨实例恢复时，所有用户的 `totp_recovery_code` 会被置为 `null`（旧实例 HMAC 在新实例无法重算）。用户下次进入 TOTP 设置页时会自动生成新恢复码。

5. **附件文件**：备份会尝试恢复附件到目标存储（R2/KV），若目标存储配置不同则会跳过，结果中记录 `skipped.attachments`。

6. 导入完成后验证：
   - 检查用户数量与源实例一致
   - 抽查几条 cipher 是否可解密（需要客户端登录验证）
   - 检查附件 skipped 数量是否符合预期

---

## 场景 3：用户丢失 TOTP 恢复码

**何时需要**：用户丢失设备且丢失了备份的恢复码，无法完成 TOTP 二步验证登录。

> **安全提示**：此操作会绕过二步验证保护，务必通过可信渠道（视频通话、线下见面）核实用户身份后再操作。

**操作步骤**：

1. 管理员获取用户 ID：
   ```bash
   curl "http://localhost:8787/api/admin/users" \
     -H "Authorization: Bearer <admin_access_token>"
   ```

2. 直接操作 D1 数据库清除该用户的 TOTP：
   ```bash
   # 使用 wrangler（本地）
   npx wrangler d1 execute passvault \
     --command "UPDATE users SET totp_secret = NULL, totp_recovery_code = NULL WHERE email = 'user@example.com';"

   # 或通过 Cloudflare 控制台 → D1 → passvault → 执行 SQL
   ```

3. 确认已清除：
   ```sql
   SELECT id, email, totp_secret, totp_recovery_code FROM users WHERE email = 'user@example.com';
   ```

4. 告知用户：
   - 现在可以不用二步验证直接登录
   - 登录后建议立即重新绑定 TOTP 并保存新恢复码
   - 此操作已记录到审计日志

**后续**：此场景暴露了缺少管理员 TOTP 重置接口的问题，可考虑后续添加 `POST /api/admin/users/:id/reset-totp` 接口以避免直接操作数据库。

---

## 场景 4：吊销所有会话（紧急安全响应）

**何时需要**：
- 怀疑 `JWT_SECRET` 或管理员账号泄露
- 检测到异常批量登录活动
- 安全事件响应需要强制全员重新认证

**影响**：所有用户（包括管理员）的 **refresh token 立即失效**。已颁发的 access token 在剩余有效期（最长 1 小时）内仍可使用，1 小时后全员需重新登录。

**操作步骤**：

1. 以管理员身份调用吊销接口：
   ```bash
   curl -X DELETE http://localhost:8787/api/admin/sessions \
     -H "Authorization: Bearer <admin_access_token>"
   ```

2. 预期响应：
   ```json
   { "success": true, "deleted": 42 }
   ```
   `deleted` 为被吊销的 refresh token 数量。

3. 若怀疑管理员 access token 也已泄露，同时轮换 `JWT_SECRET`（参见场景 1），使所有 access token 立即失效。

4. 操作会记录到审计日志（`action: admin.sessions.revoke_all`），可通过以下命令导出排查：
   ```bash
   curl "http://localhost:8787/api/admin/logs/export?format=csv&category=auth" \
     -H "Authorization: Bearer <admin_access_token>" \
     --output audit-auth.csv
   ```

5. 检查异常登录条目，重点关注 `level=security` 和 `action` 包含 `failed` 的记录：
   ```bash
   curl "http://localhost:8787/api/admin/logs/export?format=jsonl&level=security" \
     -H "Authorization: Bearer <admin_access_token>" \
     | jq 'select(.action | test("failed|brute|lock"))'
   ```

---

## 快速参考

| 场景 | 主要命令/操作 | 影响范围 |
| ---- | ------------ | -------- |
| 轮换 JWT_SECRET | 更新环境变量 + 重启 | access token 立即失效 |
| 跨实例恢复 | 管理后台 → 导入备份 | 恢复码重置为 null |
| 重置用户 TOTP | `UPDATE users SET totp_secret=NULL ...` | 该用户跳过二步验证 |
| 吊销所有会话 | `DELETE /api/admin/sessions` | 全员 refresh token 失效 |
| 导出审计日志 | `GET /api/admin/logs/export` | 只读，无影响 |
