/**
 * 云同步加密工具（纯 Web Crypto，零依赖）
 * - syncKey：32B 随机，AES-GCM-256 对称密钥，只存在于已配对设备
 * - 信封：先 gzip（CompressionStream 缺失时 z:false 直传）再 AES-GCM，密文 {v:1, z, iv, data}
 * - 配对码包裹：6位码 PBKDF2(200k) 派生 KEK，把 syncKey 包一层暂存服务器（10分钟 TTL 兜底）
 */

/** Uint8Array ↔ base64（binary string 中转，避免 btoa 的编码坑） */
export function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** hex(Uint8Array) */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/** 新同步身份：syncId=uuid，syncKey=32B 随机 */
export function generateIdentity(): { syncId: string; syncKeyBytes: Uint8Array } {
  const syncKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  return { syncId: crypto.randomUUID(), syncKeyBytes };
}

/** 6 位数字配对码（允许前导零） */
export function generatePairCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return n.toString().padStart(6, '0');
}

const gzipSupported = typeof CompressionStream !== 'undefined';
const gunzipSupported = typeof DecompressionStream !== 'undefined';

/** gzip（特性检测，缺失返回原文） */
async function gzipBytes(data: Uint8Array): Promise<Uint8Array | null> {
  if (!gzipSupported) return null;
  const cs = new CompressionStream('gzip');
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gunzip（z:false 信封直通） */
async function gunzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (!gunzipSupported) return data;
  try {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return data; // 解压失败按原样返回（信封 z 标志不符时的兜底）
  }
}

/** 规整为 ArrayBuffer 背书的副本（TS 5.7 typed-array 泛型：BufferSource 参数要求 Uint8Array<ArrayBuffer>） */
function toBuffer(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedEnvelope {
  v: 1;
  z: boolean;   // 是否 gzip 压缩
  iv: string;   // base64
  data: string; // base64
}

/** 加密：gzip → AES-GCM-256，输出 JSON 信封（服务器只存这串） */
export async function encryptBlob(syncKeyBytes: Uint8Array, plaintext: string): Promise<string> {
  const plain = new TextEncoder().encode(plaintext);
  const compressed = await gzipBytes(plain);
  const payload = compressed ?? plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(syncKeyBytes);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBuffer(payload));
  const envelope: EncryptedEnvelope = { v: 1, z: compressed !== null, iv: b64encode(iv), data: b64encode(new Uint8Array(cipher)) };
  return JSON.stringify(envelope);
}

/** 解密：逆序 AES-GCM → gunzip；失败抛错（码错/数据损坏） */
export async function decryptBlob(syncKeyBytes: Uint8Array, envelopeJson: string): Promise<string> {
  const env = JSON.parse(envelopeJson) as EncryptedEnvelope;
  if (env.v !== 1) throw new Error('不支持的快照版本');
  const key = await aesKey(syncKeyBytes);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(b64decode(env.iv)) },
    key,
    toBuffer(b64decode(env.data))
  );
  const bytes = env.z ? await gunzipBytes(new Uint8Array(plain)) : new Uint8Array(plain);
  return new TextDecoder().decode(bytes);
}

const PBKDF2_ITERATIONS = 200_000;

export interface WrappedKey {
  salt: string; // base64
  iv: string;   // base64
  data: string; // base64（密文 syncKey）
}

/** 用配对码包裹 syncKey：PBKDF2 派生 KEK → AES-GCM */
export async function wrapKeyWithCode(pairCode: string, syncKeyBytes: Uint8Array): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: toBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      await crypto.subtle.importKey('raw', new TextEncoder().encode(pairCode), 'PBKDF2', false, ['deriveBits']),
      256
    ),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, toBuffer(syncKeyBytes));
  const pkg: WrappedKey = { salt: b64encode(salt), iv: b64encode(iv), data: b64encode(new Uint8Array(cipher)) };
  return JSON.stringify(pkg);
}

/** 用配对码解开 syncKey */
export async function unwrapKeyWithCode(pairCode: string, wrappedJson: string): Promise<Uint8Array> {
  const pkg = JSON.parse(wrappedJson) as WrappedKey;
  const kek = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: toBuffer(b64decode(pkg.salt)), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      await crypto.subtle.importKey('raw', new TextEncoder().encode(pairCode), 'PBKDF2', false, ['deriveBits']),
      256
    ),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(b64decode(pkg.iv)) },
    kek,
    toBuffer(b64decode(pkg.data))
  );
  return new Uint8Array(plain);
}

/** 校验 6 位数字配对码格式 */
export function isValidPairCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
