import { apiGet } from './api.js';
import { escapeHtml, highlightLog } from './fmt.js';

const PRIORITIES = [
  [0, 'emerg'], [1, 'alert'], [2, 'crit'], [3, 'err'], [4, 'warning'], [5, 'notice'], [6, 'info'], [7, 'debug'],
];
const DEFAULT_PRIORITY = 4;
const LINE_OPTIONS = [100, 300, 1000, 3000];
const DEFAULT_LINES = 300;

export function createJournal(root) {
  root.innerHTML = `
    <form class="toolbar" data-ref="form">
      <label class="muted">mức ≤
        <select class="field" name="priority">${PRIORITIES.map(([value, name]) =>
          `<option value="${value}"${value === DEFAULT_PRIORITY ? ' selected' : ''}>${value} ${name}</option>`).join('')}</select></label>
      <select class="field" name="lines">${LINE_OPTIONS.map((n) =>
        `<option value="${n}"${n === DEFAULT_LINES ? ' selected' : ''}>${n} dòng cuối</option>`).join('')}</select>
      <input class="field" name="grep" type="search" maxlength="200" placeholder="lọc regex, vd: sshd|nginx  ( / )" spellcheck="false">
      <button type="submit" class="btn btn--primary">Đọc journal</button>
      <span class="toolbar__spacer"></span><span class="faint" data-ref="meta"></span>
    </form>
    <pre class="output" data-ref="output"><span class="faint">Bấm "Đọc journal" để lấy log hệ thống.</span></pre>`;
  const formEl = root.querySelector('[data-ref="form"]');
  const outputEl = root.querySelector('[data-ref="output"]');
  const metaEl = root.querySelector('[data-ref="meta"]');
  const submitEl = formEl.querySelector('[type="submit"]');
  let hasLoaded = false;

  async function load() {
    const params = Object.fromEntries(new FormData(formEl));
    submitEl.disabled = true;
    outputEl.innerHTML = '<div class="skel"></div><div class="skel" style="margin-top: 6px; width: 80%"></div>';
    try {
      const payload = await apiGet('/api/journal', params);
      const text = payload.stdout.trim();
      // journalctl prints "-- Boot <id> --" before "-- No entries --", so test per line.
      if (text && !/^-- No entries --$/m.test(text)) {
        outputEl.innerHTML = highlightLog(payload.stdout);
        outputEl.scrollTop = outputEl.scrollHeight;
      } else {
        outputEl.innerHTML = `<span class="faint">Không có dòng nào ở mức ≤ ${escapeHtml(params.priority)}${params.grep ? ` khớp "${escapeHtml(params.grep)}"` : ''}.</span>`;
      }
      if (payload.stderr.trim()) outputEl.insertAdjacentHTML('afterbegin', `<span class="is-danger">${escapeHtml(payload.stderr.trim())}</span>\n`);
      metaEl.textContent = `${text ? text.split('\n').length : 0} dòng · ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`;
    } catch (error) {
      outputEl.innerHTML = `<span class="is-danger">Không đọc được journal: ${escapeHtml(error.message)}</span>`;
    } finally {
      submitEl.disabled = false;
      hasLoaded = true;
    }
  }

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });

  return {
    onShow() { if (!hasLoaded) load(); },
    onKey(event) {
      if (event.key !== '/') return false;
      formEl.elements.grep.focus();
      return true;
    },
  };
}
