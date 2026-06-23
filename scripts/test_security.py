#!/usr/bin/env python3
"""PassVault 安全测试套件 — 覆盖 IDOR、权限提升、token 重放、CSP 头、refresh token 行为"""

import json
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid
import hashlib
import hmac
import base64

BASE = 'http://localhost:8787'
PASS = '✅'
FAIL = '❌'

results = []

def request(method, path, body=None, headers=None, token=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    h = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if headers:
        h.update(headers)
    if token:
        h['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            body_bytes = resp.read()
            try:
                return resp.status, json.loads(body_bytes), resp.headers
            except Exception:
                return resp.status, body_bytes.decode(), resp.headers
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        try:
            return e.code, json.loads(body_bytes), e.headers
        except Exception:
            return e.code, body_bytes.decode(), e.headers

def register_user(email, password='TestPass123!'):
    uid = str(uuid.uuid4())[:8]
    email = email.replace('@', f'+{uid}@') if '@' in email else f'{email}{uid}@example.com'
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    body = {
        'name': f'Test {uid}',
        'email': email,
        'masterPasswordHash': pw_hash,
        'masterPasswordHint': '',
        'key': 'enckey-' + uid,
        'kdf': 0,
        'kdfIterations': 100000,
    }
    status, resp, _ = request('POST', '/api/accounts/register', body)
    return email, pw_hash, uid

def login_user(email, pw_hash):
    body = {
        'grant_type': 'password',
        'username': email,
        'password': pw_hash,
        'scope': 'api offline_access',
        'client_id': 'web',
        'deviceIdentifier': str(uuid.uuid4()),
        'deviceName': 'pytest',
        'deviceType': 9,
    }
    status, resp, headers = request('POST', '/identity/connect/token', body,
                                     headers={'Content-Type': 'application/x-www-form-urlencoded'})
    # 需要 form encoded
    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(BASE + '/identity/connect/token', data=data,
                                  headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def check(name, passed, detail=''):
    sym = PASS if passed else FAIL
    msg = f'{sym} {name}'
    if detail:
        msg += f' — {detail}'
    print(msg)
    results.append((name, passed))
    return passed

# ─────────────────────────────────────────────
# 测试 0：健康检查
# ─────────────────────────────────────────────
def test_health():
    status, resp, _ = request('GET', '/api/version')
    check('服务健康检查', status == 200, f'status={status}')

# ─────────────────────────────────────────────
# 测试 1：IDOR — 用户 A 访问用户 B 的 cipher
# ─────────────────────────────────────────────
def test_idor():
    email_a, pw_a, _ = register_user('user_a@example.com')
    email_b, pw_b, _ = register_user('user_b@example.com')

    tok_a = login_user(email_a, pw_a).get('access_token')
    tok_b = login_user(email_b, pw_b).get('access_token')
    if not tok_a or not tok_b:
        check('IDOR: 跨用户 cipher 访问', False, '登录失败，无法继续')
        return

    # 用户 B 创建一个 cipher
    cipher_body = {
        'type': 1,
        'name': 'B的密码',
        'login': {'username': 'b_user', 'password': 'b_secret'},
    }
    status, resp, _ = request('POST', '/api/ciphers', cipher_body, token=tok_b)
    if status not in (200, 201) or not isinstance(resp, dict):
        check('IDOR: 跨用户 cipher 访问', False, f'创建 cipher 失败 status={status}')
        return
    cipher_id = resp.get('id') or resp.get('Id')

    # 用户 A 尝试访问用户 B 的 cipher
    status, resp, _ = request('GET', f'/api/ciphers/{cipher_id}', token=tok_a)
    check('IDOR: 跨用户 cipher 访问', status in (403, 404),
          f'期望 403/404，实际 {status}')

# ─────────────────────────────────────────────
# 测试 2：Import folderId 越权
# ─────────────────────────────────────────────
def test_import_folder_priv_esc():
    email_a, pw_a, _ = register_user('import_a@example.com')
    email_b, pw_b, _ = register_user('import_b@example.com')

    tok_a = login_user(email_a, pw_a).get('access_token')
    tok_b = login_user(email_b, pw_b).get('access_token')
    if not tok_a or not tok_b:
        check('Import folderId 越权', False, '登录失败')
        return

    # 用户 A 创建文件夹
    status, folder_resp, _ = request('POST', '/api/folders', {'name': 'A的文件夹'}, token=tok_a)
    if status not in (200, 201) or not isinstance(folder_resp, dict):
        check('Import folderId 越权', False, f'创建文件夹失败 status={status}')
        return
    folder_id_a = folder_resp.get('id') or folder_resp.get('Id')

    # 用户 B 创建 cipher，folderId 指向 A 的文件夹
    cipher_body = {
        'type': 1,
        'name': 'B的cipher试图用A的folder',
        'folderId': folder_id_a,
        'login': {'username': 'evil', 'password': 'evil'},
    }
    status, resp, _ = request('POST', '/api/ciphers', cipher_body, token=tok_b)
    if status not in (200, 201) or not isinstance(resp, dict):
        check('Import folderId 越权', False, f'创建 cipher 失败 status={status}')
        return

    # 验证返回的 cipher 中 folderId 是否被清空/忽略
    returned_folder = resp.get('folderId') or resp.get('FolderId')
    # 如果被设置成了 A 的文件夹 ID，则越权
    not_escalated = (returned_folder != folder_id_a)
    check('Import folderId 越权', not_escalated,
          f'返回 folderId={returned_folder!r}，期望非 {folder_id_a!r}')

# ─────────────────────────────────────────────
# 测试 3：附件下载 token 重放（检查 token 是否单次有效）
# ─────────────────────────────────────────────
def test_attachment_token_replay():
    # 该功能依赖 blob 存储（R2/KV），本地 dev 环境可能没有附件上传能力。
    # 测试思路：向 /api/ciphers/:id/attachment/:attachmentId/renew-access-token 请求两次，
    # 若第二次返回相同 token（说明没有轮换）则标记为潜在风险。
    # 在无附件的环境下直接跳过并标记为 N/A。
    print(f'⚠️  附件下载 token 重放 — 需要附件存储环境，本地 dev 跳过')
    results.append(('附件下载 token 重放', None))

# ─────────────────────────────────────────────
# 测试 4：CSP 响应头
# ─────────────────────────────────────────────
def test_csp_headers():
    status, resp, headers = request('GET', '/')
    csp = None
    if hasattr(headers, 'get'):
        csp = headers.get('Content-Security-Policy') or headers.get('content-security-policy')
    has_csp = bool(csp)
    check('CSP 响应头存在', has_csp, f'CSP={csp!r}')
    if has_csp:
        # 检查关键指令
        has_default = 'default-src' in csp
        no_unsafe_inline = 'unsafe-inline' not in csp or 'script-src' not in csp
        check('CSP 包含 default-src', has_default, csp[:120])

# ─────────────────────────────────────────────
# 测试 5：Refresh token 在 JWT_SECRET 轮换后仍有效（已知行为文档）
# ─────────────────────────────────────────────
def test_refresh_token_not_bound_to_jwt_secret():
    """
    已知行为：refresh token 是随机不透明字符串存储在 D1，不依赖 JWT_SECRET 签名。
    因此轮换 JWT_SECRET 不会使 refresh token 失效。
    缓解措施：使用 DELETE /api/admin/sessions 一键吊销所有 refresh token。
    此测试仅验证 admin 吊销接口存在且响应正确。
    """
    # 尝试用非 admin 账户调用（应返回 403）
    email, pw, _ = register_user('refresh_test@example.com')
    tok = login_user(email, pw).get('access_token')
    if not tok:
        check('Admin 吊销接口 (非admin 返回 403)', False, '登录失败')
        return
    status, resp, _ = request('DELETE', '/api/admin/sessions', token=tok)
    check('Admin 吊销接口 (非admin 返回 403)', status == 403,
          f'status={status}')

# ─────────────────────────────────────────────
# 测试 6：CORS / X-Content-Type-Options 头
# ─────────────────────────────────────────────
def test_security_headers():
    status, resp, headers = request('GET', '/api/version')
    xcto = None
    if hasattr(headers, 'get'):
        xcto = headers.get('X-Content-Type-Options') or headers.get('x-content-type-options')
    check('X-Content-Type-Options: nosniff', xcto == 'nosniff', f'值={xcto!r}')

# ─────────────────────────────────────────────
# 运行所有测试
# ─────────────────────────────────────────────
if __name__ == '__main__':
    print('PassVault 安全测试套件')
    print('=' * 50)
    test_health()
    print()
    print('[测试 1] IDOR 跨用户访问')
    test_idor()
    print()
    print('[测试 2] Import folderId 越权')
    test_import_folder_priv_esc()
    print()
    print('[测试 3] 附件下载 token 重放')
    test_attachment_token_replay()
    print()
    print('[测试 4] CSP 安全响应头')
    test_csp_headers()
    print()
    print('[测试 5] Refresh token 吊销接口权限控制')
    test_refresh_token_not_bound_to_jwt_secret()
    print()
    print('[测试 6] 安全响应头')
    test_security_headers()
    print()
    print('=' * 50)
    passed = sum(1 for _, r in results if r is True)
    failed = sum(1 for _, r in results if r is False)
    skipped = sum(1 for _, r in results if r is None)
    print(f'结果: {passed} 通过 / {failed} 失败 / {skipped} 跳过')
    if failed > 0:
        print('失败项目:')
        for name, r in results:
            if r is False:
                print(f'  {FAIL} {name}')
