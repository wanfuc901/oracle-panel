import { REMOTE_API_BASE } from './config.js';

const DESKTOP_TOKEN = document.querySelector('meta[name="panel-token"]').content;
// The desktop server swaps the placeholder for a real token; GitHub Pages serves it untouched.
const IS_DESKTOP = !DESKTOP_TOKEN.startsWith('__');
const API_BASE = IS_DESKTOP || location.origin === new URL(REMOTE_API_BASE).origin ? '' : REMOTE_API_BASE;
const SESSION_STORAGE_KEY = 'oracle-panel.session';
const DEFAULT_TIMEOUT_MS = 25000;
const HTTP_UNAUTHORIZED = 401;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// sessionStorage, not localStorage: other pages on the same github.io origin must not see the token after this tab closes.
function readSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
    return session && session.expires_at * 1000 > Date.now() ? session : null;
  } catch {
    return null; // storage blocked or corrupt: treat as logged out
  }
}

function writeSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage blocked: the session lives only until reload, which still works.
  }
  memorySession = session;
}

let memorySession = readSession();

export const needsLogin = () => !IS_DESKTOP;
export const hasSession = () => IS_DESKTOP || Boolean(memorySession && memorySession.expires_at * 1000 > Date.now());
export const apiHostLabel = () => (API_BASE ? new URL(API_BASE).host : location.host);

function authHeaders() {
  if (IS_DESKTOP) return { 'X-Panel-Token': DESKTOP_TOKEN };
  return memorySession ? { Authorization: `Bearer ${memorySession.token}` } : {};
}

function unreachableMessage() {
  return IS_DESKTOP
    ? 'Panel local không phản hồi. Cửa sổ python panel.py còn chạy không?'
    : `Không gọi được ${apiHostLabel()}. Server, tunnel Cloudflare hoặc service oracle-panel đang tắt?`;
}

async function request(path, init, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await fetch(API_BASE + path, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers || {}) },
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new ApiError(`Quá ${timeoutMs / 1000}s không phản hồi`, 0);
    if (error.name === 'AbortError') throw error;
    throw new ApiError(unreachableMessage(), 0);
  }
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (response.status === HTTP_UNAUTHORIZED && !IS_DESKTOP && path !== '/api/login') {
    writeSession(null);
    window.dispatchEvent(new CustomEvent('panel:unauthorized'));
  }
  if (!response.ok) throw new ApiError(payload.error || `HTTP ${response.status}`, response.status);
  return payload;
}

export function apiGet(path, params = {}, options = {}) {
  const query = new URLSearchParams(params).toString();
  return request(query ? `${path}?${query}` : path, { method: 'GET' }, options);
}

export function apiPost(path, body, options = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, options);
}

export async function login(password, otp) {
  const session = await apiPost('/api/login', { password, otp });
  writeSession({ token: session.token, expires_at: session.expires_at });
}

export async function logout() {
  try {
    await apiPost('/api/logout', {});
  } finally {
    writeSession(null);
  }
}
