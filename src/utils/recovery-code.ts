const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET_LENGTH = RECOVERY_ALPHABET.length;
const RECOVERY_MAX_UNBIASED_BYTE = Math.floor(256 / RECOVERY_ALPHABET_LENGTH) * RECOVERY_ALPHABET_LENGTH;

const HMAC_PREFIX = '$rch$v1$';
const LEGACY_ENC_PREFIX = '$rc$v1$';

function normalizeRecoveryCode(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function formatRecoveryCode(compact: string): string {
  return compact.replace(/(.{4})/g, '$1 ').trim();
}

export function createRecoveryCode(): string {
  let compact = '';
  while (compact.length < 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const b of bytes) {
      if (b >= RECOVERY_MAX_UNBIASED_BYTE) continue;
      compact += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET_LENGTH];
      if (compact.length >= 32) break;
    }
  }
  return formatRecoveryCode(compact.slice(0, 32));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const arr = hex.match(/.{2}/g);
  if (!arr) return new Uint8Array(0);
  return new Uint8Array(arr.map(h => parseInt(h, 16)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function recoveryCodeEquals(input: string, stored: string): boolean {
  return constantTimeEqual(normalizeRecoveryCode(input), normalizeRecoveryCode(stored));
}

async function deriveHmacKey(jwtSecret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(jwtSecret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('recovery-code-hmac-v1'), iterations: 100_000 },
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function deriveAesKey(jwtSecret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(jwtSecret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('recovery-code-v1'), iterations: 100_000 },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function decryptLegacyAesCode(stored: string, jwtSecret: string): Promise<string | null> {
  if (!stored.startsWith(LEGACY_ENC_PREFIX)) return null;
  const rest = stored.slice(LEGACY_ENC_PREFIX.length);
  const dollarIdx = rest.indexOf('$');
  if (dollarIdx < 0) return null;
  const iv = fromHex(rest.slice(0, dollarIdx));
  const ct = fromHex(rest.slice(dollarIdx + 1));
  const key = await deriveAesKey(jwtSecret);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// 对恢复码做 HMAC-SHA256（不可逆存储）
export async function hashRecoveryCode(plainCode: string, jwtSecret: string): Promise<string> {
  const key = await deriveHmacKey(jwtSecret);
  const normalized = normalizeRecoveryCode(plainCode);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized));
  return `${HMAC_PREFIX}${toHex(new Uint8Array(sig))}`;
}

// 验证恢复码；兼容三种格式：$rch$v1$（HMAC）、$rc$v1$（旧 AES-GCM）、明文
// fallbackSecret：设置了 RECOVERY_CODE_SECRET 时，以 JWT_SECRET 为 fallback 兼容旧哈希（迁移期）
export async function verifyRecoveryCode(
  input: string,
  stored: string | null,
  secret: string,
  fallbackSecret?: string
): Promise<boolean> {
  if (!stored) return false;
  const normalizedInput = normalizeRecoveryCode(input);

  if (stored.startsWith(HMAC_PREFIX)) {
    const storedHex = stored.slice(HMAC_PREFIX.length);
    const key = await deriveHmacKey(secret);
    const computed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalizedInput));
    if (constantTimeEqual(toHex(new Uint8Array(computed)), storedHex)) return true;
    if (fallbackSecret) {
      const fallbackKey = await deriveHmacKey(fallbackSecret);
      const fallbackComputed = await crypto.subtle.sign('HMAC', fallbackKey, new TextEncoder().encode(normalizedInput));
      return constantTimeEqual(toHex(new Uint8Array(fallbackComputed)), storedHex);
    }
    return false;
  }

  if (stored.startsWith(LEGACY_ENC_PREFIX)) {
    const plain = await decryptLegacyAesCode(stored, secret)
      ?? (fallbackSecret ? await decryptLegacyAesCode(stored, fallbackSecret) : null);
    if (!plain) return false;
    return recoveryCodeEquals(input, plain);
  }

  return recoveryCodeEquals(input, stored);
}

// 供 backup-import 迁移旧格式至 HMAC
export async function migrateLegacyRecoveryCode(
  stored: string | null,
  secret: string,
  fallbackSecret?: string
): Promise<string | null> {
  if (!stored) return null;
  if (stored.startsWith(HMAC_PREFIX)) return stored;
  if (stored.startsWith(LEGACY_ENC_PREFIX)) {
    const plain = await decryptLegacyAesCode(stored, secret)
      ?? (fallbackSecret ? await decryptLegacyAesCode(stored, fallbackSecret) : null);
    if (!plain) return null; // 跨实例密钥不同，无法解密，置空
    return hashRecoveryCode(plain, secret);
  }
  return hashRecoveryCode(stored, secret);
}
