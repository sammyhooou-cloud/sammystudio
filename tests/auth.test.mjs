import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { createSession } from '../src/auth.js';

const passwordHash = (password) => {
  const salt = Buffer.from('fixed-test-salt');
  const derived = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  return `pbkdf2-sha256$100000$${salt.toString('base64')}$${derived.toString('base64')}`;
};

function env() {
  return {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: passwordHash('valid-password'),
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true }) }) }) },
  };
}

test('rejects an invalid administrator password', async () => {
  const response = await createSession({ username: 'admin', password: 'wrong' }, env());
  assert.equal(response.status, 401);
});

test('creates a secure server session for valid credentials', async () => {
  const response = await createSession({ username: 'admin', password: 'valid-password' }, env());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
});
