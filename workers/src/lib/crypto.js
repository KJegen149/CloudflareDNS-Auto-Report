/**
 * AES-256-GCM encryption/decryption for API tokens stored in D1.
 *
 * Stored format (colon-delimited base64):
 *   <iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * Requires env.TOKEN_ENCRYPTION_KEY — a 64-character hex string (32 bytes).
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * Then store via:
 *   wrangler secret put TOKEN_ENCRYPTION_KEY
 */

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function importKey(hexKey) {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(hexKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a plaintext string.
 * Returns "iv_b64:tag_b64:ciphertext_b64".
 * @param {string} plaintext
 * @param {string} hexKey - 64-char hex string
 */
export async function encryptToken(plaintext, hexKey) {
  const key = await importKey(hexKey);
  const iv  = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM

  // AES-GCM output: ciphertext with 16-byte auth tag appended at the end
  const raw = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    new TextEncoder().encode(plaintext),
  );

  const ciphertext = raw.slice(0, raw.byteLength - 16);
  const tag        = raw.slice(raw.byteLength - 16);

  return `${b64encode(iv)}:${b64encode(tag)}:${b64encode(ciphertext)}`;
}

/**
 * Decrypt a stored "iv_b64:tag_b64:ciphertext_b64" string.
 * @param {string} stored  - colon-delimited base64
 * @param {string} hexKey  - 64-char hex string
 * @returns {Promise<string>} original plaintext
 */
export async function decryptToken(stored, hexKey) {
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format (expected iv:tag:ciphertext)');
  const [ivB64, tagB64, ciphB64] = parts;

  const iv         = b64decode(ivB64);
  const tag        = b64decode(tagB64);
  const ciphertext = b64decode(ciphB64);

  // Web Crypto expects ciphertext||tag concatenated
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const key = await importKey(hexKey);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    combined,
  );

  return new TextDecoder().decode(raw);
}
