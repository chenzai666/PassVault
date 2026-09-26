import { LIMITS } from '../config/limits';

export const SYNC_CLIENT_CACHE_CONTROL = 'private, no-store';

export async function readSyncCache(key: Request): Promise<Response | null> {
  try {
    const cache = await caches.open('vault-sync-v2');
    const hit = await cache.match(key);
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set('Cache-Control', SYNC_CLIENT_CACHE_CONTROL);
    return new Response(hit.body, { status: hit.status, headers });
  } catch {
    // 缓存异常不能使保险库同步不可用。
    return null;
  }
}

export async function writeSyncCache(key: Request, response: Response): Promise<void> {
  try {
    const copy = response.clone();
    const headers = new Headers(copy.headers);
    // 仅内部命名缓存的副本可缓存；对客户端始终返回 private, no-store。
    headers.set('Cache-Control', `public, max-age=${Math.max(1, Math.floor(LIMITS.cache.syncResponseTtlMs / 1000))}`);
    const cache = await caches.open('vault-sync-v2');
    await cache.put(key, new Response(copy.body, { status: copy.status, headers }));
  } catch {
    // 缓存写入为尽力而为，客户端响应保持可读。
  }
}
