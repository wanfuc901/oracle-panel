import { apiHostLabel, apiStream, hasSession, login, logout, needsLogin } from './api.js';
import { clockTime, duration } from './fmt.js';
import { createJournal } from './journal.js';
import { createOverview } from './overview.js';
import { createPorts } from './ports.js';
import { createProcesses } from './processes.js';
import { createServices } from './services.js';
import { createShell } from './shell.js';
import { isDialogOpen } from './ui.js';

const LIVE_STREAM_PATH = '/api/live/stream';
const RECONNECT_MS = 1000;
const ERROR_RETRY_MS = 5000;
// The server sends a frame at least every 5s, so three missed frames means the connection is dead.
const LIVE_IDLE_TIMEOUT_MS = 15000;
const STALE_AFTER_SEC = 10;
const VIEW_STORAGE_KEY = 'oracle-panel.view';
const LIVE_VIEWS = new Set(['overview', 'processes']);

const tabsEl = document.getElementById('tabs');
const bannerEl = document.getElementById('link-banner');
const linkStateEl = document.getElementById('link-state');
const linkTextEl = document.getElementById('link-text');
const hostUserEl = document.getElementById('host-user');
const hostMetaEl = document.getElementById('host-meta');
const logoutButtonEl = document.getElementById('logout-button');
const loginEl = document.getElementById('login');
const loginFormEl = document.getElementById('login-form');
const loginErrorEl = document.getElementById('login-error');
const viewEls = Object.fromEntries([...document.querySelectorAll('main > .view')].map((el) => [el.dataset.view, el]));
const tabButtons = [...tabsEl.querySelectorAll('button[data-view]')];

const views = {
  overview: createOverview(viewEls.overview),
  processes: createProcesses(viewEls.processes),
  services: createServices(viewEls.services),
  ports: createPorts(viewEls.ports),
  journal: createJournal(viewEls.journal),
  shell: createShell(viewEls.shell),
};

let activeView = 'overview';
let lastLive = null;
let liveController = null;
let isRunning = false;

function readStoredView() {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    return null; // storage blocked: fall back to the overview
  }
}

function showView(name) {
  if (!views[name]) return;
  activeView = name;
  for (const button of tabButtons) button.classList.toggle('is-active', button.dataset.view === name);
  for (const [viewName, el] of Object.entries(viewEls)) el.hidden = viewName !== name;
  try { localStorage.setItem(VIEW_STORAGE_KEY, name); } catch { /* remembered tab is optional */ }
  history.replaceState(null, '', `#${name}`);
  views[name].onShow?.();
  if (lastLive?.state && LIVE_VIEWS.has(name)) views[name].render(lastLive.state);
}

function renderLinkState(live) {
  const { state, status, error, link, age_sec: ageSec = Infinity } = live;
  if (state) {
    hostUserEl.textContent = `${link.split('@')[0]}@${state.host.hostname}`;
    hostMetaEl.textContent = `${apiHostLabel()} · ${state.host.os}`;
    views.shell.setPrompt(hostUserEl.textContent);
  }
  const isHealthy = status === 'ok' && ageSec < STALE_AFTER_SEC;
  linkStateEl.dataset.state = status === 'connecting' ? 'connecting' : (isHealthy ? 'ok' : 'error');
  if (status === 'connecting') linkTextEl.textContent = `đang lấy số liệu từ ${link}…`;
  else if (isHealthy) linkTextEl.textContent = `trực tuyến · ${clockTime(Date.now() / 1000)}`;
  else linkTextEl.textContent = state ? `mất kết nối · số liệu cũ ${duration(ageSec)}` : 'chưa lấy được số liệu';
  bannerEl.hidden = !error;
  if (error) bannerEl.textContent = `Lỗi lấy số liệu: ${error}\nPanel tự thử lại mỗi vài giây.`;
}

function renderLive(live) {
  lastLive = live;
  renderLinkState(live);
  if (live.state && LIVE_VIEWS.has(activeView)) views[activeView].render(live.state);
}

function renderLiveFailure(error) {
  linkStateEl.dataset.state = 'error';
  linkTextEl.textContent = 'không gọi được API';
  bannerEl.hidden = false;
  bannerEl.textContent = error.message;
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function streamLive(signal) {
  while (!signal.aborted) {
    let retryMs = RECONNECT_MS;
    try {
      await apiStream(LIVE_STREAM_PATH, renderLive, { signal, idleTimeoutMs: LIVE_IDLE_TIMEOUT_MS });
    } catch (error) {
      if (signal.aborted) return; // logout, a 401 or a hidden tab stopped it on purpose
      retryMs = ERROR_RETRY_MS;
      renderLiveFailure(error);
    }
    await pause(retryMs, signal);
  }
}

function startLive() {
  if (liveController) return;
  liveController = new AbortController();
  // Not awaited on purpose: the loop lives until stopLive() aborts it and never rejects.
  streamLive(liveController.signal);
}

function stopLive() {
  liveController?.abort();
  liveController = null;
}

function startApp() {
  loginEl.hidden = true;
  logoutButtonEl.hidden = !needsLogin();
  isRunning = true;
  const hashView = location.hash.slice(1);
  showView(views[hashView] ? hashView : (readStoredView() || 'overview'));
  if (!document.hidden) startLive();
}

function showLogin(message = '') {
  isRunning = false;
  stopLive();
  document.getElementById('login-host').textContent = apiHostLabel();
  loginErrorEl.hidden = !message;
  loginErrorEl.textContent = message;
  loginEl.hidden = false;
  loginFormEl.elements.password.focus();
}

async function submitLogin(event) {
  event.preventDefault();
  const { password, otp } = loginFormEl.elements;
  const submitEl = loginFormEl.querySelector('[type="submit"]');
  submitEl.disabled = true;
  loginErrorEl.hidden = true;
  try {
    await login(password.value, otp.value);
    password.value = '';
    otp.value = '';
    startApp();
  } catch (error) {
    otp.value = '';
    loginErrorEl.textContent = error.message;
    loginErrorEl.hidden = false;
    otp.focus();
  } finally {
    submitEl.disabled = false;
  }
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

document.addEventListener('keydown', (event) => {
  if (!isRunning || isDialogOpen() || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === 'Escape' && isTypingTarget(event.target)) {
    event.target.blur();
    return;
  }
  if (isTypingTarget(event.target)) return;
  const tabIndex = Number(event.key) - 1;
  if (Number.isInteger(tabIndex) && tabButtons[tabIndex]) {
    showView(tabButtons[tabIndex].dataset.view);
    event.preventDefault();
    return;
  }
  if (views[activeView].onKey?.(event)) event.preventDefault();
});

tabsEl.addEventListener('click', (event) => {
  const name = event.target.closest('button[data-view]')?.dataset.view;
  if (name) showView(name);
});
loginFormEl.addEventListener('submit', submitLogin);
logoutButtonEl.addEventListener('click', async () => {
  try {
    await logout();
    showLogin('Đã đăng xuất.');
  } catch (error) {
    showLogin(`Đã xoá phiên trên máy này, nhưng server chưa xác nhận: ${error.message}`);
  }
});
// A stream is not throttled in background tabs the way a timer was, so close it and let the server sampler idle.
document.addEventListener('visibilitychange', () => {
  if (!isRunning) return;
  if (document.hidden) stopLive();
  else startLive();
});
window.addEventListener('panel:unauthorized', () => showLogin('Phiên đăng nhập đã hết hạn, đăng nhập lại.'));

if (hasSession()) startApp();
else showLogin();
