import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCredentials, passwordToggleLabel } from '../dist/app.js';

test('requires both credentials', () => {
  assert.deepEqual(validateCredentials({ username: '', password: '' }), {
    username: '请输入用户名',
    password: '请输入密码',
  });
});

test('rejects credentials that are too short', () => {
  assert.deepEqual(validateCredentials({ username: 'ab', password: '12345' }), {
    username: '用户名至少需要 3 个字符',
    password: '密码至少需要 6 个字符',
  });
});

test('accepts trimmed valid credentials', () => {
  assert.deepEqual(validateCredentials({ username: '  creator  ', password: 'secret8' }), {});
});

test('describes the next password visibility action', () => {
  assert.equal(passwordToggleLabel(false), '显示密码');
  assert.equal(passwordToggleLabel(true), '隐藏密码');
});
