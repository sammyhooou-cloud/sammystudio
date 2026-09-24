const encoder = new TextEncoder();

export function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function randomToken(size = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function pkceChallenge(verifier) {
  return base64url(await sha256(verifier));
}

export function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function verifyPassword(password, encoded) {
  const [version, iterationsText, saltText, expectedText] = String(encoded || '').split('$');
  if (version !== 'pbkdf2-sha256') return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000) return false;
  const salt = Uint8Array.from(atob(saltText), (char) => char.charCodeAt(0));
  const expected = Uint8Array.from(atob(expectedText), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expected.length * 8));
  return constantTimeEqual(actual, expected);
}

async function encryptionKey(secret) {
  return crypto.subtle.importKey('raw', await sha256(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(JSON.stringify(value)));
  return `${base64url(iv)}.${base64url(cipher)}`;
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export async function decryptJson(value, secret) {
  const [ivText, cipherText] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64url(ivText) }, await encryptionKey(secret), decodeBase64url(cipherText));
  return JSON.parse(new TextDecoder().decode(plain));
}
