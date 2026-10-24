import { apiGet, apiPost } from './api.js';
import { escapeHtml, highlightLog } from './fmt.js';
import { confirmAction, reportCommand, showNotice, skeletonRows } from './ui.js';

const LOG_LINE_OPTIONS = [100, 300, 1000];
const SSH_UNITS = new Set(['ssh.service', 'sshd.service']);
const STATE_FILTERS = {
  running: { label: 'Đang chạy', test: (s) => s.sub === 'running' },
  failed: { label: 'Lỗi', test: (s) => s.active === 'failed' },
  all: { label: 'Tất cả', test: () => true },
};
const ACTIONS = {
  start: { label: 'Khởi động', confirm: false },
  restart: { label: 'Khởi động lại', confirm: true },
  stop: { label: 'Dừng', confirm: true, danger: true },
  enable: { label: 'Bật tự chạy khi boot', confirm: false },
  disable: { label: 'Tắt tự chạy khi boot', confirm: true },
};
const COLUMN_COUNT = 4;

function activeCell(service) {
  if (service.active === 'failed') return '<span class="is-danger">failed</span>';
  if (service.sub === 'running') return '<span class="is-ok">running</span>';
  return `<span class="faint">${escapeHtml(service.active)}/${escapeHtml(service.sub)}</span>`;
}

function buildLayout(root) {
  root.innerHTML = `
    <div class="svc">
      <div style="display: flex; flex-direction: column; gap: 8px; min-height: 0">
        <div class="toolbar">
          <input class="field" type="search" data-ref="filter" placeholder="lọc dịch vụ  ( / )" spellcheck="false">
          <div class="seg" data-ref="seg">${Object.entries(STATE_FILTERS).map(([key, f]) =>
            `<button type="button" data-filter="${key}">${f.label}</button>`).join('')}</div>
          <span class="toolbar__spacer"></span>
          <span class="muted" data-ref="count"></span>
          <button type="button" class="btn" data-ref="reload">Tải lại</button>
        </div>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>Dịch vụ</th><th>Trạng thái</th><th>Khi boot</th><th>Mô tả</th></tr></thead>
          <tbody data-ref="rows">${skeletonRows(COLUMN_COUNT, 12)}</tbody>
        </table></div>
      </div>
      <aside class="svc__detail" data-ref="detail"><p class="empty">Chọn một dịch vụ để xem log và khởi động / dừng.</p></aside>
    </div>`;
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  return { filter: ref('filter'), seg: ref('seg'), count: ref('count'), reload: ref('reload'), rows: ref('rows'), detail: ref('detail') };
}

function detailHtml(service, logLines) {
  const isRunning = service.sub === 'running';
  const isEnabled = service.enabled === 'enabled';
  const shown = ['start', 'restart', 'stop', isEnabled ? 'disable' : 'enable']
    .filter((action) => !(action === 'start' && isRunning) && !(action === 'stop' && !isRunning));
  return `
    <div><span class="is-amber">${escapeHtml(service.unit)}</span> ${activeCell(service)}
      <div class="muted">${escapeHtml(service.description || 'không có mô tả')}</div>
      <div class="faint">khi boot: ${escapeHtml(service.enabled || 'không rõ')}</div></div>
    <div class="toolbar">${shown.map((action) =>
      `<button type="button" class="btn${ACTIONS[action].danger ? ' btn--danger' : ''}" data-action="${action}">${ACTIONS[action].label}</button>`).join('')}</div>
    <div class="toolbar"><span class="label">journalctl -u</span><span class="toolbar__spacer"></span>
      <select class="field" data-ref="log-lines">${LOG_LINE_OPTIONS.map((n) =>
        `<option value="${n}"${n === logLines ? ' selected' : ''}>${n} dòng</option>`).join('')}</select>
      <button type="button" class="btn" data-ref="log-reload">Tải log</button></div>
    <pre class="output" data-ref="log"><div class="skel"></div></pre>`;
}

export function createServices(root) {
  const els = buildLayout(root);
  const view = { services: null, stateFilter: 'running', selectedUnit: null, logLines: LOG_LINE_OPTIONS[0], loading: false };

  function renderTable() {
    for (const button of els.seg.children) button.classList.toggle('is-active', button.dataset.filter === view.stateFilter);
    if (!view.services) return;
    const needle = els.filter.value.trim().toLowerCase();
    const matches = view.services.filter(STATE_FILTERS[view.stateFilter].test)
      .filter((s) => !needle || `${s.unit} ${s.description}`.toLowerCase().includes(needle));
    const failedCount = view.services.filter(STATE_FILTERS.failed.test).length;
    els.count.innerHTML = `${matches.length}/${view.services.length}${failedCount ? ` · <span class="is-danger">${failedCount} lỗi</span>` : ''}`;
    const emptyCopy = view.stateFilter === 'failed' && !needle ? 'Không có dịch vụ nào đang lỗi.' : 'Không dịch vụ nào khớp bộ lọc.';
    els.rows.innerHTML = matches.length ? matches.map((s) =>
      `<tr data-unit="${escapeHtml(s.unit)}"${s.unit === view.selectedUnit ? ' class="is-selected"' : ''}>
        <td>${escapeHtml(s.unit.replace(/\.service$/, ''))}</td><td>${activeCell(s)}</td>
        <td class="muted">${escapeHtml(s.enabled)}</td><td class="wide">${escapeHtml(s.description)}</td></tr>`).join('')
      : `<tr><td colspan="${COLUMN_COUNT}" class="empty">${emptyCopy}</td></tr>`;
  }

  async function loadServices() {
    if (view.loading) return;
    view.loading = true;
    els.reload.disabled = true;
    try {
      view.services = (await apiGet('/api/services')).services;
      renderTable();
      renderDetail(false);
    } catch (error) {
      els.rows.innerHTML = `<tr><td colspan="${COLUMN_COUNT}" class="empty is-danger">Không tải được danh sách dịch vụ: ${escapeHtml(error.message)}</td></tr>`;
    } finally {
      view.loading = false;
      els.reload.disabled = false;
    }
  }

  async function loadLogs() {
    const logEl = els.detail.querySelector('[data-ref="log"]');
    if (!logEl || !view.selectedUnit) return;
    try {
      const payload = await apiGet('/api/service/logs', { unit: view.selectedUnit, lines: view.logLines });
      logEl.innerHTML = payload.stdout.trim() ? highlightLog(payload.stdout) : '<span class="faint">Dịch vụ này chưa ghi dòng log nào.</span>';
      logEl.scrollTop = logEl.scrollHeight;
    } catch (error) {
      logEl.innerHTML = `<span class="is-danger">Không đọc được log: ${escapeHtml(error.message)}</span>`;
    }
  }

  function renderDetail(reloadLogs) {
    const service = view.services?.find((s) => s.unit === view.selectedUnit);
    if (!service) return;
    const logEl = els.detail.querySelector('[data-ref="log"]');
    const preservedLog = reloadLogs ? null : logEl?.innerHTML;
    els.detail.innerHTML = detailHtml(service, view.logLines);
    if (preservedLog) els.detail.querySelector('[data-ref="log"]').innerHTML = preservedLog;
    else loadLogs();
  }

  async function runAction(action) {
    const spec = ACTIONS[action];
    const unit = view.selectedUnit;
    const sshWarning = SSH_UNITS.has(unit) && (action === 'stop' || action === 'disable')
      ? '\n\nĐây là SSH: dừng nó thì panel này và mọi phiên SSH sẽ mất kết nối, phải vào Oracle Cloud Console để bật lại.' : '';
    if (spec.confirm && !(await confirmAction({ title: `${spec.label} ${unit}?`, body: `sudo systemctl ${action} ${unit}${sshWarning}`, confirmLabel: spec.label }))) return;
    els.detail.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      reportCommand(`${spec.label} ${unit}`, await apiPost('/api/service/action', { unit, action }));
    } catch (error) {
      showNotice(`${spec.label} ${unit}: ${error.message}`, 'error');
    }
    await loadServices();
    await loadLogs();
  }

  els.seg.addEventListener('click', (event) => {
    const key = event.target.closest('[data-filter]')?.dataset.filter;
    if (!key) return;
    view.stateFilter = key;
    renderTable();
  });
  els.rows.addEventListener('click', (event) => {
    const unit = event.target.closest('tr[data-unit]')?.dataset.unit;
    if (!unit) return;
    view.selectedUnit = unit;
    renderTable();
    renderDetail(true);
  });
  els.detail.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) runAction(action);
    if (event.target.closest('[data-ref="log-reload"]')) loadLogs();
  });
  els.detail.addEventListener('change', (event) => {
    if (event.target.dataset.ref !== 'log-lines') return;
    view.logLines = Number(event.target.value);
    loadLogs();
  });
  els.filter.addEventListener('input', renderTable);
  els.reload.addEventListener('click', loadServices);
  renderTable();

  return {
    onShow() { if (!view.services) loadServices(); },
    onKey(event) {
      if (event.key !== '/') return false;
      els.filter.focus();
      return true;
    },
  };
}
