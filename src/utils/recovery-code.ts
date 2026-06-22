const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET_LENGTH = RECOVERY_ALPHABET.length;
const RECOVERY_MAX_UNBIASED_BYTE = Math.floor(256 / RECOVERY_ALPHABET_LENGTH) * RECOVERY_ALPHABET_LENGTH;

// 加密前缀标记，用于区分明文（旧数据向后兼容）和密文
const ENC_PREFIX = '$rc$v1$';

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

// 比较两个明文恢复码（常量时间）
export function recoveryCodeEquals(input: string, plainStored: string | null | undefined): boolean {
  if (!plainStored) return false;
  const a = new TextEncoder().encode(normalizeRecoveryCode(input));
  const b = new TextEncoder().encode(normalizeRecoveryCode(plainStored));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function deriveRecoveryCodeKey(jwtSecret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(jwtSecret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('recovery-code-v1'), iterations: 100_000 },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const arr = hex.match(/.{2}/g);
  if (!arr) return new Uint8Array(0);
  return new Uint8Array(arr.map(h => parseInt(h, 16)));
}

// 用 AES-GCM 加密恢复码后存入数据库
export async function encryptRecoveryCode(plainCode: string, jwtSecret: string): Promise<string> {
  const key = await deriveRecoveryCodeKey(jwtSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainCode));
  return `${ENC_PREFIX}${toHex(iv)}$${toHex(new Uint8Array(ct))}`;
}

// 解密恢复码；对旧明文数据向后兼容，直接返回原值
export async function decryptRecoveryCode(stored: string | null, jwtSecret: string): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 旧明文数据，向后兼容
  const rest = stored.slice(ENC_PREFIX.length);
  const dollarIdx = rest.indexOf('$');
  if (dollarIdx < 0) return null;
  const iv = fromHex(rest.slice(0, dollarIdx));
  const ct = fromHex(rest.slice(dollarIdx + 1));
  const key = await deriveRecoveryCodeKey(jwtSecret);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
