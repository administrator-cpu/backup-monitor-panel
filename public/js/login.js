// Sign-in form: password + authenticator code, posted as JSON.

const form = document.getElementById('signin');
const password = document.getElementById('password');
const code = document.getElementById('code');
const submit = document.getElementById('signin-submit');
const error = document.getElementById('signin-error');

function showError(text, field) {
  error.textContent = text;
  error.hidden = false;
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

for (const field of [password, code]) field.addEventListener('input', () => field.removeAttribute('aria-invalid'));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  const digits = code.value.replace(/\s/g, '');
  if (!password.value) return showError('Enter your password.', password);
  if (!/^\d{6}$/.test(digits)) return showError('Enter the 6-digit code from your authenticator app.', code);

  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: JSON.stringify({ password: password.value, code: digits }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) {
      window.location.replace('/');
      return;
    }
    code.value = '';
    showError((data && data.error) || `Sign-in failed (HTTP ${res.status}).`, res.status === 429 ? null : code);
  } catch {
    showError('The panel could not be reached. Check the internet connection.');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

password.focus();
