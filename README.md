<p align="center">
  <img src="./webapp/public/nodewarden-logo.svg" alt="PassVault Logo" width="80" />
</p>

<h1 align="center">PassVault</h1>

<p align="center">
  自托管密码管理器，兼容 Bitwarden 客户端
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-LGPL--3.0-2ea44f" alt="License: LGPL-3.0" /></a>
  <a href="https://github.com/chenzai666/PassVault/releases/latest"><img src="https://img.shields.io/github/v/release/chenzai666/PassVault?display_name=tag" alt="Latest Release" /></a>
</p>

> **免责声明**  
> 本项目仅供学习与自用，请定期备份你的密码库。  
> 本项目与 Bitwarden 官方无关，请不要向 Bitwarden 官方反馈本项目的问题。

---

## 功能一览

| 能力 | 支持情况 | 说明 |
|---|---|---|
| 网页密码库 | ✅ | 原创 Web Vault 界面 |
| PWA 支持 | ✅ | 可安装、离线使用、App 快捷方式 |
| Web Vault 离线查看 | ✅ | 网页端支持离线查看保险库 |
| Passkey 登录 | ✅ | 支持 WebAuthn/FIDO2 无密码登录 |
| 全量同步 `/api/sync` | ✅ | 已针对官方客户端做兼容优化 |
| 附件上传 / 下载 | ✅ | Cloudflare R2 或 KV |
| Send | ✅ | 支持文本与文件 Send |
| 导入 / 导出 | ✅ | 支持 Bitwarden JSON / CSV / ZIP（含附件） |
| 云端备份中心 | ✅ | 支持 WebDAV / S3 定时备份 |
| TOTP / Steam TOTP | ✅ | 含 `steam://` 支持 |
| 多用户 | ✅ | 支持邀请码注册 |
| 组织 / 集合 | ❌ | 未实现 |
| SSO / SCIM | ❌ | 未实现 |

---

## 已测试客户端

- ✅ Windows 桌面端
- ✅ 手机 App
- ✅ 浏览器扩展
- ✅ Linux 桌面端
- ⚠️ macOS 桌面端尚未完整验证

---

## Docker 部署

### 快速启动

```bash
git clone https://github.com/chenzai666/PassVault.git
cd PassVault

# 复制环境变量模板
cp .env.example .env

# 编辑 .env，至少设置 JWT_SECRET（32 位以上随机字符串）
vi .env

# 构建并启动
docker compose up -d
```

服务默认监听 `8787` 端口。建议配合 nginx 反代 + HTTPS 使用。

### nginx 反代配置示例

```nginx
location ^~ / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_http_version 1.1;
}
```

### 环境变量说明

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT 签名密钥，至少 32 位随机字符串 |
| `WEBAUTHN_RP_ID` | 推荐 | Passkey 用，填你的域名（如 `vault.example.com`） |
| `WEBAUTHN_RP_NAME` | 可选 | Passkey 显示名称 |
| `WEBAUTHN_ALLOWED_ORIGINS` | 可选 | 允许的来源，多个用逗号分隔 |

### 更新

```bash
git pull
docker compose build
docker compose up -d
```

---

## Cloudflare Workers 部署

PassVault 同样支持部署到 Cloudflare Workers（无服务器，免费额度内零成本）。

```bash
npm install
npx wrangler login

# R2 模式（需绑卡，单文件最大 100 MB）
npm run deploy

# KV 模式（无需绑卡，单文件最大 25 MiB）
npm run deploy:kv
```

---

## 主要特性

### PWA 渐进式 Web 应用

- ✅ **可安装到桌面** — 像原生应用一样运行
- ✅ **离线使用** — Service Worker 缓存，离线也能查看密码
- ✅ **App 快捷方式** — 快速启动保险库、TOTP 代码
- ✅ **后台解密** — Web Worker 处理解密，不阻塞 UI

### Passkey 无密码登录

- ✅ **WebAuthn/FIDO2 支持** — 使用指纹、Face ID 等登录
- ✅ **PRF 密钥解锁** — Passkey 可直接解锁保险库
- ✅ **官方客户端兼容** — Chromium 系浏览器扩展可用 Passkey 登录
- ✅ **多设备同步** — 支持 iCloud、Google Password Manager 等

### 云端备份

- 远程备份支持 **WebDAV** 与 **S3**
- 支持 OneDrive（通过 Koofr）、Google Drive（通过 Koofr）、Cloudflare R2、Backblaze B2 等
- 勾选"包含附件"后附件单独存放在 `attachments/`，后续备份按稳定 blob 名复用，不全量重传
- 远程还原时按需读取附件，缺失附件安全跳过，不留脏记录

---

## 导入 / 导出

**支持导入来源：**
- Bitwarden JSON / CSV
- Bitwarden 密码库 + 附件 ZIP
- PassVault JSON
- 多种浏览器 / 密码管理器格式

**支持导出方式：**
- Bitwarden JSON / 加密 JSON
- 带附件的 ZIP
- PassVault JSON
- 备份中心完整手动导出

---

## 开源协议

LGPL-3.0 License

---

## 致谢

- [NodeWarden](https://github.com/shuaiplus/NodeWarden) — 本项目基于 NodeWarden 定制
- [Bitwarden](https://bitwarden.com/) — 原始设计与客户端
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) — 服务端实现参考
- [Cloudflare Workers](https://workers.cloudflare.com/) — 无服务器平台
