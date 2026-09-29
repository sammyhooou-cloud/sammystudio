const form = document.querySelector('#login-form');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const toggle = document.querySelector('#password-toggle');
const error = document.querySelector('#login-error');
const submit = form.querySelector('button[type="submit"]');
let inFlight = false;

toggle.onclick = () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? '隐藏' : '显示';
  toggle.setAttribute('aria-pressed', String(visible));
};

form.onsubmit = async (event) => {
  event.preventDefault();
  if (inFlight) return;
  inFlight = true;
  submit.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : '登录失败，请重试');
    location.replace('/workspace');
  } catch (failure) {
    error.textContent = failure?.message || '登录失败，请重试';
  } finally {
    inFlight = false;
    submit.disabled = false;
  }
};
