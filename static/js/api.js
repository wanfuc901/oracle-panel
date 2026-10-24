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

function toApiError(error, timeoutMs) {
  if (error instanceof ApiError || error.name === 'AbortError') return error;
  if (error.name === 'TimeoutError') return new ApiError(`Quá ${timeoutMs / 1000}s không phản hồi`, 0);
  return new ApiError(unreachableMessage(), 0);
}

async function openResponse(path, init, signal, timeoutMs) {
  try {
    return await fetch(API_BASE + path, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) }, signal });
  } catch (error) {
    throw toApiError(error, timeoutMs);
  }
}

async function readPayload(response, path) {
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (response.status === HTTP_UNAUTHORIZED && !IS_DESKTOP && path !== '/api/login') {
    writeSession(null);
    window.dispatchEvent(new CustomEvent('panel:unauthorized'));
  }
  if (!response.ok) throw new ApiError(payload.error || `HTTP ${response.status}`, response.status);
  return payload;
}

async function request(path, init, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const response = await openResponse(path, init, AbortSignal.any(signals), timeoutMs);
  return readPayload(response, path);
}

async function readEventFrames(body, onMessage, onActivity) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onActivity();
    const frames = (pending + value).split('\n\n');
    pending = frames.pop();
    for (const frame of frames) {
      const dataLines = frame.split('\n').filter((line) => line.startsWith('data:'));
      if (dataLines.length) onMessage(parseFrame(dataLines.map((line) => line.slice(5)).join('\n')));
    }
  }
}

function parseFrame(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('Luồng số liệu trả về JSON hỏng', 0);
  }
}

/**
 * Reads a Server-Sent Events stream through fetch (EventSource cannot send the auth headers) and calls
 * onMessage with every JSON `data:` frame. Resolves when the server ends the stream; rejects with ApiError
 * when nothing arrives for idleTimeoutMs, which is how a silently dropped connection gets noticed.
 */
export async function apiStream(path, onMessage, { idleTimeoutMs, signal }) {
  const streamController = new AbortController();
  let idleTimer = 0;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => streamController.abort(new DOMException('stream idle', 'TimeoutError')), idleTimeoutMs);
  };
  restartIdleTimer();
  try {
    const streamSignal = AbortSignal.any([streamController.signal, signal]);
    const init = { method: 'GET', headers: { Accept: 'text/event-stream' } };
    const response = await openResponse(path, init, streamSignal, idleTimeoutMs);
    if (!response.ok) await readPayload(response, path);
    await readEventFrames(response.body, onMessage, restartIdleTimer);
  } catch (error) {
    throw toApiError(error, idleTimeoutMs);
  } finally {
    clearTimeout(idleTimer);
    streamController.abort(); // closes the connection when onMessage threw mid-stream
  }
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
