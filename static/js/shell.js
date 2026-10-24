import { apiPost } from './api.js';
import { escapeHtml } from './fmt.js';

const HISTORY_STORAGE_KEY = 'oracle-panel.shell-history';
const HISTORY_LIMIT = 100;
const TIMEOUT_OPTIONS = [30, 120, 300];
const REQUEST_SLACK_MS = 5000;
const STARTER_COMMANDS = ['df -h', 'free -h', 'sudo systemctl --failed', 'sudo apt list --upgradable 2>/dev/null | tail -n +2', 'last -n 10', 'sudo journalctl -p err -n 30 --no-pager'];

function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return []; // storage blocked or corrupt: start with an empty history
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)));
  } catch {
    // Private window / quota: history just won't survive a reload, which is acceptable.
  }
}

function entryHtml(command, payload, errorMessage) {
  const head = `<div class="shell-entry__cmd">$ ${escapeHtml(command)}</div>`;
  if (errorMessage) return `${head}<pre class="is-stderr">${escapeHtml(errorMessage)}</pre>`;
  const exitClass = payload.ok ? 'is-ok' : 'is-danger';
  const meta = `<div class="shell-entry__meta"><span class="${exitClass}">exit ${payload.exit_code}</span> · ${payload.duration_ms} ms${payload.truncated ? ' · output bị cắt ở 512 KB' : ''}</div>`;
  const stdout = payload.stdout ? `<pre>${escapeHtml(payload.stdout)}</pre>` : '';
  const stderr = payload.stderr ? `<pre class="is-stderr">${escapeHtml(payload.stderr)}</pre>` : '';
  return head + stdout + stderr + meta;
}

export function createShell(root) {
  root.innerHTML = `
    <div class="shell-log" data-ref="log">
      <p class="muted">Mỗi lệnh chạy trong một <span class="is-amber">bash -lc</span> mới: <span class="faint">cd</span>, biến môi trường không giữ giữa các lệnh, nối bằng <span class="faint">&amp;&amp;</span> nếu cần.
      Lệnh hỏi input (nano, top, sudo cần mật khẩu) sẽ treo đến hết timeout.</p>
      <p class="faint">Thử nhanh: ${STARTER_COMMANDS.map((c) => `<button type="button" class="btn" data-starter="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join(' ')}</p>
    </div>
    <form class="shell-form" data-ref="form">
      <span class="shell-form__prompt" data-ref="prompt">$</span>
      <input name="command" autocomplete="off" spellcheck="false" placeholder="lệnh shell, Enter để chạy, ↑ ↓ lịch sử">
      <select class="field" name="timeout" title="timeout">${TIMEOUT_OPTIONS.map((s) => `<option value="${s}">${s}s</option>`).join('')}</select>
    </form>`;
  const logEl = root.querySelector('[data-ref="log"]');
  const formEl = root.querySelector('[data-ref="form"]');
  const promptEl = root.querySelector('[data-ref="prompt"]');
  const inputEl = formEl.elements.command;
  const history = loadHistory();
  let historyCursor = history.length;
  let isRunning = false;

  function appendEntry(html) {
    logEl.insertAdjacentHTML('beforeend', `<div class="shell-entry">${html}</div>`);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function run(command) {
    if (isRunning || !command.trim()) return;
    isRunning = true;
    inputEl.disabled = true;
    if (history.at(-1) !== command) history.push(command);
    saveHistory(history);
    historyCursor = history.length;
    const timeoutSec = Number(formEl.elements.timeout.value);
    const pendingEl = document.createElement('div');
    pendingEl.className = 'shell-entry';
    pendingEl.innerHTML = `<div class="shell-entry__cmd">$ ${escapeHtml(command)}</div><div class="skel" style="width: 40%; margin-top: 4px"></div>`;
    logEl.append(pendingEl);
    logEl.scrollTop = logEl.scrollHeight;
    try {
      const payload = await apiPost('/api/exec', { command, timeout_sec: timeoutSec }, { timeoutMs: timeoutSec * 1000 + REQUEST_SLACK_MS });
      pendingEl.remove();
      appendEntry(entryHtml(command, payload, null));
    } catch (error) {
      pendingEl.remove();
      appendEntry(entryHtml(command, null, error.message));
    } finally {
      isRunning = false;
      inputEl.disabled = false;
      inputEl.value = '';
      inputEl.focus();
    }
  }

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    run(inputEl.value);
  });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    historyCursor = Math.max(0, Math.min(history.length, historyCursor + (event.key === 'ArrowUp' ? -1 : 1)));
    inputEl.value = history[historyCursor] ?? '';
  });
  logEl.addEventListener('click', (event) => {
    const starter = event.target.closest('[data-starter]')?.dataset.starter;
    if (starter) run(starter);
  });

  return {
    setPrompt(label) { promptEl.textContent = `${label}:~$`; },
    onShow() { inputEl.focus(); },
    onKey: () => false,
  };
}
