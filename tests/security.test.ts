import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, Request as WorkerRequest, Response as WorkerResponse } from 'miniflare';
import { RateLimitService, getClientIdentifier } from '../src/services/ratelimit';
import { createUserWithInvite } from '../src/services/storage-user-repo';
import { ensureStorageSchema } from '../src/services/storage-schema';
import { readSyncCache, writeSyncCache } from '../src/services/sync-cache';
import type { User } from '../src/types';

const run = promisify(execFile);
const bind = (statement: D1PreparedStatement, ...values: unknown[]) => statement.bind(...values.map(v => v === undefined ? null : v));
function user(): User {
  return { id: randomUUID(), email: `${randomUUID()}@example.test`, name: '事务测试',
    masterPasswordHash: 'test-only', masterPasswordHint: null, key: '2.a|b|c',
    privateKey: '2.a|b|c', publicKey: 'test-only', kdfType: 0, kdfIterations: 600000,
    securityStamp: randomUUID(), role: 'user', status: 'active', totpSecret: null,
    totpRecoveryCode: null, apiKey: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test('安全修复回归（一次性 D1/R2/Cache）', { timeout: 120_000 }, async t => {
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    host: '127.0.0.1', port: 0, log: new Log(LogLevel.ERROR),
    bindings: { JWT_SECRET: randomBytes(48).toString('hex'), CLIENT_IP_HEADER: 'X-Real-IP' },
    d1Databases: { DB: 'test-db' }, r2Buckets: ['ATTACHMENTS'],
    durableObjects: {
      NOTIFICATIONS_HUB: { className: 'NotificationsHub', useSQLite: true },
      BACKUP_TRANSFER_RUNNER: { className: 'BackupTransferRunner', useSQLite: true },
    },
  });
  try {
    const url = await mf.ready;
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureStorageSchema(db);

    await t.test('真实 HTTP 权限、附件单次令牌、刷新及同步隔离', async () => {
      const result = await run(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-X', 'utf8', 'scripts/test_security.py'], { env: { ...process.env, PASSVAULT_TEST_URL: url.origin }, timeout: 60_000 });
      console.log(result.stdout + result.stderr);
    });
    const admin = await db.prepare('SELECT id FROM users WHERE role = ?').bind('admin').first<{ id: string }>();
    assert.ok(admin);
    async function invite(code: string, expiry = '2099-01-01T00:00:00.000Z') {
      await db.prepare("INSERT INTO invites VALUES(?, ?, NULL, ?, 'active', ?, ?)")
        .bind(code, admin!.id, expiry, new Date().toISOString(), new Date().toISOString()).run();
    }
    await t.test('无效、过期邀请码不创建用户', async () => {
      await invite('expired', '2000-01-01T00:00:00.000Z');
      for (const code of ['missing', 'expired']) {
        const candidate = user();
        assert.equal(await createUserWithInvite(db, bind, candidate, code), false);
        assert.equal(await db.prepare('SELECT id FROM users WHERE id = ?').bind(candidate.id).first(), null);
      }
    });
    await t.test('同一邀请码并发只创建一个账户', async () => {
      await invite('concurrent');
      const candidates = Array.from({ length: 12 }, user);
      const results = await Promise.all(candidates.map(candidate => createUserWithInvite(db, bind, candidate, 'concurrent')));
      assert.equal(results.filter(Boolean).length, 1);
      const stored = await Promise.all(candidates.map(candidate => db.prepare('SELECT id FROM users WHERE id = ?').bind(candidate.id).first()));
      assert.equal(stored.filter(Boolean).length, 1);
    });
    await t.test('邀请码更新失败时事务回滚用户', async () => {
      await invite('fault');
      await db.prepare("CREATE TRIGGER fail_invite BEFORE UPDATE ON invites WHEN OLD.code = 'fault' BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
      const candidate = user();
      try {
        await assert.rejects(createUserWithInvite(db, bind, candidate, 'fault'), /injected failure/);
        assert.equal(await db.prepare('SELECT id FROM users WHERE id = ?').bind(candidate.id).first(), null);
        assert.equal((await db.prepare('SELECT status FROM invites WHERE code = ?').bind('fault').first<{ status: string }>())?.status, 'active');
      } finally { await db.prepare('DROP TRIGGER fail_invite').run(); }
    });
    await t.test('重复邮箱不会消耗邀请码', async () => {
      await invite('duplicate');
      const existing = await db.prepare('SELECT email FROM users LIMIT 1').first<{ email: string }>();
      await assert.rejects(createUserWithInvite(db, bind, { ...user(), email: existing!.email }, 'duplicate'), /UNIQUE/);
      assert.equal((await db.prepare('SELECT status FROM invites WHERE code = ?').bind('duplicate').first<{ status: string }>())?.status, 'active');
    });
    await t.test('原子限流：并发 50 次只放行预算 5 次', async () => {
      const limiter = new RateLimitService(db);
      const id = randomUUID();
      const results = await Promise.all(Array.from({ length: 50 }, () => limiter.consumeBudgetWithWindow(id, 5, 3600)));
      assert.equal(results.filter(r => r.allowed).length, 5);
      assert.equal((await limiter.consumeBudgetWithWindow(id, 5, 3600)).allowed, false);
      assert.equal((await limiter.consumeBudgetWithWindow(randomUUID(), 5, 3600)).allowed, true);
    });
    await t.test('代理信任：Docker 忽略 CF/XFF，Workers 不回退 XFF', () => {
      const request = new Request('https://vault.example.test/', { headers: {
        'CF-Connecting-IP': '192.0.2.1', 'X-Real-IP': '198.51.100.10', 'X-Forwarded-For': '203.0.113.1' } });
      assert.equal(getClientIdentifier(request, { CLIENT_IP_HEADER: 'X-Real-IP' }), 'ip4:198.51.100.10');
      assert.equal(getClientIdentifier(request), 'ip4:192.0.2.1');
      assert.equal(getClientIdentifier(new Request('https://vault.example.test/', { headers: { 'X-Forwarded-For': '192.0.2.1' } })), null);
    });
    await t.test('内部同步缓存命中，外部仍禁止缓存，用户键隔离', async () => {
      const saved = globalThis.caches;
      const savedRequest = globalThis.Request;
      const savedResponse = globalThis.Response;
      globalThis.Request = WorkerRequest as unknown as typeof Request;
      globalThis.Response = WorkerResponse as unknown as typeof Response;
      globalThis.caches = await mf.getCaches() as unknown as CacheStorage;
      try {
        const key = new Request('https://vault.example.test/__cache/user-a/revision-1');
        const response = new Response('encrypted-only', { headers: { 'Cache-Control': 'private, no-store' } });
        await writeSyncCache(key, response);
        const hit = await readSyncCache(key);
        assert.ok(hit);
        assert.equal(await hit.text(), 'encrypted-only');
        assert.equal(hit.headers.get('Cache-Control'), 'private, no-store');
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
        assert.equal(await response.text(), 'encrypted-only');
        assert.equal(await readSyncCache(new Request('https://vault.example.test/__cache/user-b/revision-1')), null);
      } finally {
        globalThis.caches = saved;
        globalThis.Request = savedRequest;
        globalThis.Response = savedResponse;
      }
    });
    await t.test('Python 测试失败时进程返回非零', async () => {
      // 保留原脚本的 unittest.main，仅替换加载的用例，验证断言失败的退出状态。
      const script = "import runpy,unittest; Forced=type('ForcedFailure',(unittest.TestCase,),{'runTest':lambda self:self.fail('injected failure')}); unittest.TestLoader.loadTestsFromModule=lambda *a,**k:unittest.TestSuite([Forced()]); runpy.run_path('scripts/test_security.py',run_name='__main__')";
      await assert.rejects(run(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-X', 'utf8', '-c', script], {
        env: { ...process.env, PASSVAULT_TEST_URL: url.origin }, timeout: 30_000,
      }), (error: any) => error.code === 1 && /FAILED/.test(error.stderr));
    });
  } finally { await mf.dispose(); }
});
