# Security Policy

## 支持版本

| 版本    | 支持状态 |
| ------- | -------- |
| latest  | ✅ 受支持 |
| 旧版本  | ❌ 不受支持，请升级 |

## 报告漏洞

如发现安全漏洞，请**不要**公开提交 Issue，而是通过以下方式联系：

- **Email**: 发送到项目维护者邮箱（见 README）
- **GitHub**: 使用 [Security Advisories](../../security/advisories/new) 私密报告

请在报告中包含：
1. 漏洞描述及影响范围
2. 复现步骤（最小化 PoC）
3. 可能的修复建议（可选）

我们承诺在 **72 小时**内确认收到，并在 **14 天**内给出初步评估。

## 威胁模型

PassVault 是**自托管**密码管理器，威胁模型基于以下假设：

### 信任边界

| 组件 | 信任级别 | 说明 |
| ---- | -------- | ---- |
| Cloudflare Workers 运行时 | 信任 | 宿主环境 |
| D1 数据库 | 信任 | 仅 Workers 可访问 |
| R2 / KV 存储 | 信任 | 仅 Workers 可访问 |
| 管理员用户 | 信任 | 拥有完整管理权限 |
| 普通用户 | 部分信任 | 只能访问自己的数据 |
| 外部网络请求 | 不信任 | 所有输入均需验证 |

### 已知设计决策

**Vault 数据加密**：所有 vault 条目（密码、笔记等）在客户端加密后才上传，服务端只存储密文。服务端**无法**解密 vault 内容。

**Master Password**：仅用于客户端密钥派生（PBKDF2/Argon2id），服务端存储的是派生后的验证哈希，不可用于解密 vault。

**TOTP 恢复码**：存储为 HMAC-SHA256（`$rch$v1$` 格式），不可逆。丢失恢复码后需重置 TOTP。派生密钥优先使用 `RECOVERY_CODE_SECRET`，未设置时回退至 `JWT_SECRET`。

**Refresh Token**：存储于 D1 `refresh_tokens` 表，是随机不透明字符串，不依赖 `JWT_SECRET` 签名。`JWT_SECRET` 轮换不会使 refresh token 失效。如需紧急吊销所有会话，使用管理员接口 `DELETE /api/admin/sessions`。

**备份文件**：包含所有用户数据的密文（vault 条目），不包含 S3 凭证、`JWT_SECRET` 或 `CRON_SECRET`。备份签名使用 `HMAC-SHA256(db.json, JWT_SECRET)`，跨实例恢复时签名不匹配为预期行为。

### 超出范围（不在威胁模型内）

- 攻击者拥有 Cloudflare 账号访问权限
- 服务器端代码执行（Workers 沙箱层面的攻击）
- 用户端设备被物理入侵
- 密码学算法本身的破解

## 安全配置建议

部署前请确认以下配置：

- [ ] `JWT_SECRET` 长度 ≥ 32 字节，使用随机生成（`openssl rand -hex 32`）
- [ ] `RECOVERY_CODE_SECRET` 与 `JWT_SECRET` 分开设置（可选但推荐，`openssl rand -hex 32`）
- [ ] `CRON_SECRET` 已设置并保密
- [ ] 部署在 HTTPS 环境下
- [ ] R2/KV bucket 不对外公开访问
- [ ] 定期备份并测试恢复流程

## 已修复的安全问题

| 日期 | 类别 | 描述 |
| ---- | ---- | ---- |
| 2026-06 | 加密降级 | TOTP 恢复码从 AES-GCM 可逆加密改为 HMAC-SHA256 不可逆存储 |
| 2026-06 | 密钥分离 | 新增 `RECOVERY_CODE_SECRET` 独立 secret，与 JWT 签名密钥解耦 |
| 2026-06 | 完整性 | 备份文件增加 HMAC-SHA256 完整性签名 |
| 2026-06 | 访问控制 | 新增管理员一键吊销所有 refresh token 接口 |
| 2026-06 | 依赖安全 | 升级修复 CVE 的依赖包 |
