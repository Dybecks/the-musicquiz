/**
 * Spotify login with the Authorization Code + PKCE flow. This needs no backend
 * and no client secret: only the app's Client ID, which is public.
 * https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
 */

const SCOPES = [
  'streaming', // Web Playback SDK (Premium)
  'user-read-email',
  'user-read-private', // tells us whether the account is Premium
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const KEYS = {
  clientId: 'mq.spotify.clientId',
  verifier: 'mq.spotify.verifier',
  state: 'mq.spotify.state',
  token: 'mq.spotify.token',
  afterLogin: 'mq.spotify.afterLogin',
};

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Space-separated scopes the user granted. Missing on tokens saved by older versions. */
  scope?: string;
}

export function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

export function getClientId(): string {
  return localStorage.getItem(KEYS.clientId) || import.meta.env.VITE_SPOTIFY_CLIENT_ID || '';
}

export function setClientId(id: string): void {
  if (id.trim()) localStorage.setItem(KEYS.clientId, id.trim());
  else localStorage.removeItem(KEYS.clientId);
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export interface LoginOptions {
  /** Extra permissions to ask for on top of the playback ones, e.g. 'user-top-read'. */
  extraScopes?: string[];
  /** Remembered across the redirect; read it back with takeAfterLogin(). */
  afterLogin?: string;
}

export async function login({ extraScopes = [], afterLogin }: LoginOptions = {}): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error('Add your Spotify Client ID first.');
  // Keep what was granted before, so asking for more doesn't drop anything.
  const scope = [...new Set([...SCOPES.split(' '), ...grantedScopes(), ...extraScopes])].join(' ');
  if (afterLogin) sessionStorage.setItem(KEYS.afterLogin, afterLogin);
  else sessionStorage.removeItem(KEYS.afterLogin);
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(KEYS.verifier, verifier);
  sessionStorage.setItem(KEYS.state, state);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope,
    state,
  });
  window.location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

/** Call once on page load. Finishes the login if Spotify just redirected back. */
export async function handleRedirect(): Promise<string | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return null;

  const cleanUrl = () => {
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    window.history.replaceState({}, '', url.toString());
  };

  if (error) {
    cleanUrl();
    sessionStorage.removeItem(KEYS.afterLogin);
    return `Spotify login was cancelled (${error}).`;
  }
  const returnedState = url.searchParams.get('state');
  const expectedState = sessionStorage.getItem(KEYS.state);
  const verifier = sessionStorage.getItem(KEYS.verifier);
  cleanUrl();
  if (!verifier || !expectedState || returnedState !== expectedState) {
    return 'Spotify login could not be completed. Please try again.';
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri(),
      client_id: getClientId(),
      code_verifier: verifier,
    }),
  });
  sessionStorage.removeItem(KEYS.verifier);
  sessionStorage.removeItem(KEYS.state);
  if (!res.ok) {
    sessionStorage.removeItem(KEYS.afterLogin);
    return `Spotify login failed (${res.status}).`;
  }
  saveToken(await res.json());
  return null;
}

function saveToken(body: { access_token: string; refresh_token?: string; expires_in: number; scope?: string }): void {
  const previous = readToken();
  const token: StoredToken = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    scope: body.scope ?? previous?.scope,
  };
  localStorage.setItem(KEYS.token, JSON.stringify(token));
}

function readToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(KEYS.token);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
}

export function isLoggedIn(): boolean {
  return readToken() !== null;
}

/** The permissions the logged-in user granted (empty when logged out). */
export function grantedScopes(): string[] {
  const token = readToken();
  if (!token) return [];
  return (token.scope ?? SCOPES).split(/\s+/).filter(Boolean);
}

export function hasScopes(scopes: string[]): boolean {
  const granted = new Set(grantedScopes());
  return scopes.every((s) => granted.has(s));
}

/** Returns (once) what login() was asked to do after the redirect. */
export function takeAfterLogin(): string | null {
  const value = sessionStorage.getItem(KEYS.afterLogin);
  sessionStorage.removeItem(KEYS.afterLogin);
  return value;
}

export function logout(): void {
  localStorage.removeItem(KEYS.token);
}

let refreshing: Promise<string | null> | null = null;

/** Returns a valid access token, refreshing it if needed, or null if logged out. */
export async function getAccessToken(): Promise<string | null> {
  const token = readToken();
  if (!token) return null;
  if (Date.now() < token.expiresAt) return token.accessToken;
  if (!token.refreshToken) {
    logout();
    return null;
  }
  refreshing ??= (async () => {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: getClientId(),
      }),
    });
    if (!res.ok) {
      logout();
      return null;
    }
    saveToken(await res.json());
    return readToken()?.accessToken ?? null;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
