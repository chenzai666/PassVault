"""对一次性本地测试实例执行权限、附件重放及会话回归测试。"""
import json
import os
import sys
import unittest
import urllib.request
import urllib.error
import urllib.parse
import uuid

BASE = os.environ.get('PASSVAULT_TEST_URL', 'http://127.0.0.1:8787').rstrip('/')
ENC = '2.' + '|'.join(['YQ==', 'Yg==', 'Yw=='])


def request(method, path, body=None, token=None, raw=False):
    url = path if path.startswith(BASE + '/') else BASE + path
    if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(BASE).netloc:
        raise ValueError('测试只允许访问指定实例')
    headers = {'Origin': BASE, 'X-Real-IP': '192.0.2.10', 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    if raw:
        headers['Content-Type'] = 'application/octet-stream'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        content = response.read()
        try:
            result = json.loads(content)
        except (ValueError, UnicodeDecodeError):
            result = content
        return response.status, result, response.headers


def expect(method, path, body=None, token=None, statuses=(200,), raw=False):
    status, result, headers = request(method, path, body, token, raw)
    if status not in statuses:
        raise AssertionError(f'{method} {path.split("?")[0]}: 预期 {statuses}，实际 {status}: {result}')
    return result, headers


def register(invite=None):
    email = f'{uuid.uuid4()}@example.test'
    password_hash = uuid.uuid4().hex
    body = {'email': email, 'name': '安全测试', 'masterPasswordHash': password_hash,
            'key': ENC, 'keys': {'publicKey': 'test-only', 'encryptedPrivateKey': ENC},
            'kdf': 0, 'kdfIterations': 600000}
    if invite:
        body['inviteCode'] = invite
    expect('POST', '/api/accounts/register', body)
    result, _ = expect('POST', '/identity/connect/token', {
        'grant_type': 'password', 'username': email, 'password': password_hash,
        'scope': 'api offline_access', 'client_id': 'web',
        'deviceIdentifier': str(uuid.uuid4()), 'deviceName': '安全测试', 'deviceType': '9'})
    if not result.get('access_token'):
        raise AssertionError('未获得访问令牌')
    return result


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = register()['access_token']
        users = []
        for _ in range(2):
            invitation, _ = expect('POST', '/api/admin/invites', {}, cls.admin, statuses=(201,))
            users.append(register(invitation['code']))
        cls.a, cls.b = [u['access_token'] for u in users]
        cls.refresh = users[0]['refresh_token']
        cls.cipher, _ = expect('POST', '/api/ciphers', {
            'type': 1, 'name': ENC, 'login': {'username': ENC, 'password': ENC}}, cls.b)

    def test_cross_user_cipher(self):
        path = '/api/ciphers/' + self.cipher['id']
        for method, body in [('GET', None), ('PUT', {'name': ENC}), ('DELETE', None)]:
            status, _, _ = request(method, path, body, self.a)
            self.assertIn(status, (403, 404))
        expect('GET', path, token=self.b)

    def test_foreign_folder(self):
        folder, _ = expect('POST', '/api/folders', {'name': ENC}, self.a)
        status, _, _ = request('POST', '/api/ciphers', {
            'type': 1, 'name': ENC, 'folderId': folder['id']}, self.b)
        self.assertEqual(status, 404)

    def test_attachment_replay(self):
        cipher_id = self.cipher['id']
        payload = b'encrypted-test-fixture'
        attachment, _ = expect('POST', f'/api/ciphers/{cipher_id}/attachment/v2', {
            'fileName': ENC, 'key': ENC, 'fileSize': len(payload)}, self.b)
        expect('PUT', attachment['url'], payload, statuses=(201,), raw=True)
        path = f'/api/ciphers/{cipher_id}/attachment/{attachment["attachmentId"]}'
        status, _, _ = request('GET', path, token=self.a)
        self.assertIn(status, (403, 404))
        metadata, _ = expect('GET', path, token=self.b)
        data, _ = expect('GET', metadata['url'])
        self.assertEqual(data, payload)
        status, _, _ = request('GET', metadata['url'])
        self.assertEqual(status, 401)

    def test_security_headers(self):
        _, headers = expect('GET', '/api/version')
        self.assertEqual(headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(headers.get('X-Frame-Options'), 'DENY')
        script_policy = next(p.strip() for p in headers['Content-Security-Policy'].split(';') if p.strip().startswith('script-src'))
        self.assertNotIn('unsafe-inline', script_policy)

    def test_refresh_and_admin_access(self):
        status, _, _ = request('DELETE', '/api/admin/sessions', token=self.a)
        self.assertEqual(status, 403)
        token, _ = expect('POST', '/identity/connect/token', {
            'grant_type': 'refresh_token', 'refresh_token': self.refresh})
        self.assertTrue(token.get('access_token'))
        self.assertNotEqual(token.get('refresh_token'), self.refresh)

    def test_sync_isolation_and_cache_policy(self):
        for _ in range(2):
            own, headers = expect('GET', '/api/sync', token=self.b)
            self.assertEqual(headers['Cache-Control'], 'private, no-store')
            self.assertIn(self.cipher['id'], [c['id'] for c in own['ciphers']])
            other, _ = expect('GET', '/api/sync', token=self.a)
            self.assertNotIn(self.cipher['id'], [c['id'] for c in other['ciphers']])


if __name__ == '__main__':
    unittest.main(verbosity=2)
