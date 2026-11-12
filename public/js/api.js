// Calls to the panel API. A 401 with signIn means the session ended.

export class SignedOut extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'SignedOut';
  }
}

export async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Panel-Request': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    throw new Error('The panel could not be reached. Check the internet connection.');
  }
  if (res.type === 'opaqueredirect') throw new SignedOut();
  const isJson = (res.headers.get('Content-Type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (data && data.signIn) throw new SignedOut(data.error);
  if (!res.ok || !data || data.ok !== true) {
    throw new Error((data && data.error) || `The panel answered with HTTP ${res.status}.`);
  }
  return data;
}

export const getStatus = () => request('/api/status');
export const signOut = () => request('/api/logout', { method: 'POST', body: {} });
export const queueCommand = (action) => request('/api/commands', { method: 'POST', body: { action } });
export const cancelCommand = (id) => request(`/api/commands/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
