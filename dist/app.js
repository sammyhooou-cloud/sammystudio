export function validateCredentials({ username, password }) {
  const errors = {};
  const cleanUsername = username.trim();

  if (!cleanUsername) errors.username = '请输入用户名';
  else if (cleanUsername.length < 3) errors.username = '用户名至少需要 3 个字符';

  if (!password) errors.password = '请输入密码';
  else if (password.length < 6) errors.password = '密码至少需要 6 个字符';

  return errors;
}

export function passwordToggleLabel(isVisible) {
  return isVisible ? '隐藏密码' : '显示密码';
}

function setupLogin() {
  const form = document.querySelector('#login-form');
  const username = document.querySelector('#username');
  const password = document.querySelector('#password');
  const toggle = document.querySelector('#password-toggle');
  const submit = document.querySelector('#login-submit');
  const formView = document.querySelector('#form-view');
  const successView = document.querySelector('#success-view');

  const fields = { username, password };

  function setFieldError(name, message = '') {
    const field = fields[name];
    const error = document.querySelector(`#${name}-error`);
    field.setAttribute('aria-invalid', String(Boolean(message)));
    error.textContent = message;
  }

  function validateField(name) {
    const errors = validateCredentials({ username: username.value, password: password.value });
    setFieldError(name, errors[name]);
  }

  Object.keys(fields).forEach((name) => {
    fields[name].addEventListener('blur', () => validateField(name));
    fields[name].addEventListener('input', () => {
      if (fields[name].getAttribute('aria-invalid') === 'true') validateField(name);
    });
  });

  toggle.addEventListener('click', () => {
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    toggle.setAttribute('aria-pressed', String(!visible));
    toggle.setAttribute('aria-label', passwordToggleLabel(!visible));
    toggle.querySelector('span').textContent = visible ? '显示' : '隐藏';
    password.focus({ preventScroll: true });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const errors = validateCredentials({ username: username.value, password: password.value });
    Object.keys(fields).forEach((name) => setFieldError(name, errors[name]));

    const firstInvalid = Object.keys(fields).find((name) => errors[name]);
    if (firstInvalid) {
      fields[firstInvalid].focus();
      return;
    }

    submit.disabled = true;
    submit.querySelector('.button-label').textContent = '正在进入';
    window.setTimeout(() => {
      formView.hidden = true;
      successView.hidden = false;
      successView.focus();
    }, 650);
  });
}

if (typeof document !== 'undefined') setupLogin();

