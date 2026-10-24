import { apiPost } from './api.js';
import { bytes, duration, escapeHtml, percent } from './fmt.js';
import { confirmAction, reportCommand, showNotice, skeletonRows } from './ui.js';

const HOT_CPU_PERCENT = 50;
const STATE_NAMES = { R: 'đang chạy', S: 'ngủ', D: 'chờ I/O', Z: 'zombie', T: 'bị dừng', t: 'đang trace', I: 'nhàn rỗi', X: 'đã chết' };
const COLUMNS = [
  { key: 'name', label: 'Tên', type: 'text' },
  { key: 'pid', label: 'PID', type: 'num' },
  { key: 'user', label: 'User', type: 'text' },
  { key: 'cpu', label: 'CPU', type: 'num' },
  { key: 'rss', label: 'RAM', type: 'num' },
  { key: 'threads', label: 'Luồng', type: 'num' },
  { key: 'state', label: 'TT', type: 'text' },
  { key: 'age_sec', label: 'Đã chạy', type: 'num' },
  { key: 'cmd', label: 'Lệnh', type: 'text' },
];
const SIGNAL_COPY = {
  TERM: { verb: 'Kết thúc', detail: 'Gửi SIGTERM: tiến trình được dọn dẹp rồi thoát.' },
  KILL: { verb: 'Buộc dừng', detail: 'Gửi SIGKILL: dừng ngay, không lưu gì. Chỉ dùng khi TERM không ăn.' },
  STOP: { verb: 'Tạm dừng', detail: 'Gửi SIGSTOP: đóng băng tiến trình đến khi gửi CONT.' },
  CONT: { verb: 'Tiếp tục', detail: 'Gửi SIGCONT: chạy lại tiến trình đang bị STOP.' },
};

const rowKey = (proc) => `${proc.pid}:${proc.start}`;
const isKernelThread = (proc) => proc.cmd.startsWith('[');

function rowHtml(proc, selectedKey, totalRam) {
  const selected = rowKey(proc) === selectedKey ? ' class="is-selected"' : '';
  const cpuClass = proc.cpu >= HOT_CPU_PERCENT ? ' is-danger' : '';
  const ramShare = totalRam ? ` title="${percent((proc.rss / totalRam) * 100)} RAM"` : '';
  return `<tr data-key="${rowKey(proc)}"${selected}>
    <td>${escapeHtml(proc.name)}</td><td class="num">${proc.pid}</td><td>${escapeHtml(proc.user)}</td>
    <td class="num${cpuClass}">${proc.cpu.toFixed(1)}</td><td class="num"${ramShare}>${bytes(proc.rss)}</td>
    <td class="num">${proc.threads}</td>
    <td><span class="state-chip" title="${STATE_NAMES[proc.state] || proc.state}">${escapeHtml(proc.state)}</span></td>
    <td class="num">${duration(proc.age_sec)}</td><td class="wide">${escapeHtml(proc.cmd)}</td></tr>`;
}

function buildLayout(root) {
  root.innerHTML = `
    <div class="toolbar">
      <input class="field" type="search" data-ref="filter" placeholder="lọc tên, lệnh, user, PID  ( / )" spellcheck="false">
      <label class="muted"><input type="checkbox" data-ref="hide-kernel" checked> ẩn luồng kernel</label>
      <span class="toolbar__spacer"></span>
      <span class="muted" data-ref="summary"></span>
      <button type="button" class="btn" data-ref="pause">Dừng cập nhật <kbd>P</kbd></button>
    </div>
    <div class="table-wrap"><table class="grid">
      <thead><tr>${COLUMNS.map((c) => `<th data-sort="${c.key}" class="${c.type === 'num' ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>
      <tbody data-ref="rows">${skeletonRows(COLUMNS.length, 14)}</tbody>
    </table></div>
    <div class="proc-actions" data-ref="actions"></div>`;
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  return { filter: ref('filter'), hideKernel: ref('hide-kernel'), summary: ref('summary'), pause: ref('pause'),
    rows: ref('rows'), actions: ref('actions'), head: root.querySelector('thead') };
}

export function createProcesses(root) {
  const els = buildLayout(root);
  const view = { procs: [], visible: [], totalRam: 0, sortKey: 'cpu', sortDesc: true, selectedKey: null, paused: false };

  function visibleProcs() {
    const needle = els.filter.value.trim().toLowerCase();
    const column = COLUMNS.find((c) => c.key === view.sortKey);
    const direction = view.sortDesc ? -1 : 1;
    return view.procs
      .filter((p) => !(els.hideKernel.checked && isKernelThread(p)))
      .filter((p) => !needle || `${p.name} ${p.cmd} ${p.user} ${p.pid}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const primary = column.type === 'num' ? a[view.sortKey] - b[view.sortKey] : String(a[view.sortKey]).localeCompare(String(b[view.sortKey]));
        return primary * direction || b.rss - a.rss;
      });
  }

  function renderActions() {
    const selected = view.procs.find((p) => rowKey(p) === view.selectedKey);
    if (!selected) {
      els.actions.innerHTML = '<span class="proc-actions__who faint">Chọn một dòng để kết thúc / buộc dừng. Phím ↑ ↓ để di chuyển.</span>';
      return;
    }
    const stopped = selected.state === 'T';
    els.actions.innerHTML = `<span class="proc-actions__who"><span class="is-amber">${escapeHtml(selected.name)}</span> PID ${selected.pid} · ${escapeHtml(selected.user)}</span>
      <button type="button" class="btn" data-signal="TERM">Kết thúc <kbd>Del</kbd></button>
      <button type="button" class="btn btn--danger" data-signal="KILL">Buộc dừng <kbd>Shift+Del</kbd></button>
      <button type="button" class="btn" data-signal="${stopped ? 'CONT' : 'STOP'}">${stopped ? 'Tiếp tục' : 'Tạm dừng'}</button>`;
  }

  function renderTable() {
    view.visible = visibleProcs();
    const needle = els.filter.value.trim();
    els.rows.innerHTML = view.visible.length
      ? view.visible.map((p) => rowHtml(p, view.selectedKey, view.totalRam)).join('')
      : `<tr><td colspan="${COLUMNS.length}" class="empty">Không tiến trình nào khớp <strong>"${escapeHtml(needle)}"</strong>.</td></tr>`;
    const totalCpu = view.procs.reduce((sum, p) => sum + p.cpu, 0);
    els.summary.textContent = `${view.visible.length}/${view.procs.length} tiến trình · tổng CPU ${percent(totalCpu)}`;
    for (const th of els.head.querySelectorAll('th')) {
      const sorted = th.dataset.sort === view.sortKey;
      th.classList.toggle('is-sorted', sorted);
      th.textContent = COLUMNS.find((c) => c.key === th.dataset.sort).label + (sorted ? (view.sortDesc ? ' ▼' : ' ▲') : '');
    }
    renderActions();
  }

  async function sendSignal(signalName) {
    const target = view.procs.find((p) => rowKey(p) === view.selectedKey);
    if (!target) return;
    const copy = SIGNAL_COPY[signalName];
    const confirmed = await confirmAction({
      title: `${copy.verb} ${target.name} (PID ${target.pid})?`,
      body: `${copy.detail}\n\n${target.cmd}`,
      confirmLabel: copy.verb,
    });
    if (!confirmed) return;
    try {
      reportCommand(`${copy.verb} PID ${target.pid}`, await apiPost('/api/process/signal', { pid: target.pid, start: target.start, signal: signalName }));
    } catch (error) {
      showNotice(`${copy.verb} PID ${target.pid}: ${error.message}`, 'error');
    }
  }

  function moveSelection(step) {
    if (!view.visible.length) return;
    const index = view.visible.findIndex((p) => rowKey(p) === view.selectedKey);
    const next = Math.max(0, Math.min(view.visible.length - 1, index === -1 ? 0 : index + step));
    view.selectedKey = rowKey(view.visible[next]);
    renderTable();
    els.rows.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function togglePause() {
    view.paused = !view.paused;
    els.pause.classList.toggle('btn--primary', view.paused);
    els.pause.innerHTML = view.paused ? 'Đang dừng, bấm để chạy tiếp <kbd>P</kbd>' : 'Dừng cập nhật <kbd>P</kbd>';
  }

  els.rows.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-key]');
    if (!row) return;
    view.selectedKey = row.dataset.key;
    renderTable();
  });
  els.head.addEventListener('click', (event) => {
    const key = event.target.closest('th')?.dataset.sort;
    if (!key) return;
    view.sortDesc = key === view.sortKey ? !view.sortDesc : COLUMNS.find((c) => c.key === key).type === 'num';
    view.sortKey = key;
    renderTable();
  });
  els.actions.addEventListener('click', (event) => {
    const signalName = event.target.closest('[data-signal]')?.dataset.signal;
    if (signalName) sendSignal(signalName);
  });
  els.filter.addEventListener('input', renderTable);
  els.hideKernel.addEventListener('change', renderTable);
  els.pause.addEventListener('click', togglePause);

  return {
    render(state) {
      if (view.paused) return;
      view.procs = state.procs;
      view.totalRam = state.mem.total;
      renderTable();
    },
    onKey(event) {
      const keyActions = {
        ArrowDown: () => moveSelection(1),
        ArrowUp: () => moveSelection(-1),
        Delete: () => sendSignal(event.shiftKey ? 'KILL' : 'TERM'),
        p: togglePause,
        '/': () => els.filter.focus(),
      };
      const action = keyActions[event.key];
      if (!action) return false;
      action();
      return true;
    },
  };
}
