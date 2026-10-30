// Minimal client for the GitHub REST "contents" API: read and commit the JSON data file of the site.
// Docs: https://docs.github.com/rest/repos/contents

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function headers(settings, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (settings.token) h.Authorization = `Bearer ${settings.token}`;
  return h;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function contentsUrl(settings) {
  return `${API}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${encodePath(settings.path)}`;
}

async function failure(res) {
  let detail = '';
  try {
    detail = (await res.json()).message || '';
  } catch {
    /* body is not JSON */
  }
  const hints = {
    401: 'jeton invalide ou expiré',
    403: 'accès refusé ou limite de requêtes atteinte',
    404: 'dépôt, branche ou fichier introuvable (ou jeton sans accès)',
    409: 'conflit de version',
    422: 'requête refusée par GitHub',
  };
  return new GitHubError(`GitHub ${res.status} : ${hints[res.status] || detail || res.statusText}${detail && hints[res.status] ? ` (${detail})` : ''}`, res.status);
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function getDefaultBranch(settings) {
  const res = await fetch(`${API}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`, {
    headers: headers(settings),
    cache: 'no-store',
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()).default_branch;
}

// Returns { sha, text } for the data file, or null when it does not exist yet on that branch.
export async function fetchFile(settings) {
  const url = `${contentsUrl(settings)}?ref=${encodeURIComponent(settings.branch)}`;
  const res = await fetch(url, { headers: headers(settings), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const meta = await res.json();
  if (Array.isArray(meta)) throw new GitHubError('Le chemin indiqué est un dossier, pas un fichier.', 400);
  if (meta.encoding === 'base64' && meta.content) return { sha: meta.sha, text: base64ToUtf8(meta.content) };
  // Files over 1 MB come without inline content: ask for the raw body instead.
  const raw = await fetch(url, { headers: headers(settings, 'application/vnd.github.raw+json'), cache: 'no-store' });
  if (!raw.ok) throw await failure(raw);
  return { sha: meta.sha, text: await raw.text() };
}

// Creates or updates the data file in one commit. Returns the new blob sha.
export async function putFile(settings, text, sha, message) {
  const body = { message, content: utf8ToBase64(text), branch: settings.branch };
  if (sha) body.sha = sha;
  const res = await fetch(contentsUrl(settings), {
    method: 'PUT',
    headers: { ...headers(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()).content.sha;
}
