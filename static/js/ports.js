import { apiGet } from './api.js';
import { escapeHtml } from './fmt.js';
import { skeletonRows } from './ui.js';

const COLUMN_COUNT = 5;
const WILDCARD_ADDRESSES = new Set(['*', '0.0.0.0', '::']);
const LOOPBACK_PATTERN = /^(127\.|::1$|localhost)/;

function exposure(address) {
  const bareAddress = address.split('%')[0];
  if (WILDCARD_ADDRESSES.has(bareAddress)) return '<span class="is-amber">mọi interface</span>';
  if (LOOPBACK_PATTERN.test(bareAddress)) return '<span class="faint">chỉ localhost</span>';
  return '<span class="muted">mạng nội bộ VCN</span>';
}

function ownersHtml(processes) {
  if (!processes.length) return '<span class="faint">không rõ</span>';
  return processes.map((p) => `${escapeHtml(p.name)} <span class="faint">${p.pids.length > 1 ? `×${p.pids.length}` : p.pids[0]}</span>`).join(', ');
}

export function createPorts(root) {
  root.innerHTML = `
    <div class="toolbar">
      <span class="muted">Socket đang lắng nghe (sudo ss -tulpn). "Mọi interface" chỉ ra được Internet khi Security List của Oracle Cloud cũng mở cổng đó.</span>
      <span class="toolbar__spacer"></span>
      <button type="button" class="btn" data-ref="reload">Tải lại</button>
    </div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Giao thức</th><th class="num">Cổng</th><th>Địa chỉ</th><th>Phạm vi</th><th>Tiến trình</th></tr></thead>
      <tbody data-ref="rows">${skeletonRows(COLUMN_COUNT, 8)}</tbody>
    </table></div>`;
  const rowsEl = root.querySelector('[data-ref="rows"]');
  const reloadEl = root.querySelector('[data-ref="reload"]');

  async function load() {
    reloadEl.disabled = true;
    try {
      const { ports } = await apiGet('/api/ports');
      const sorted = [...ports].sort((a, b) => a.proto.localeCompare(b.proto) || Number(a.port) - Number(b.port));
      rowsEl.innerHTML = sorted.length ? sorted.map((p) => `<tr>
        <td>${escapeHtml(p.proto)}</td><td class="num">${escapeHtml(p.port)}</td><td>${escapeHtml(p.address)}</td>
        <td>${exposure(p.address)}</td><td>${ownersHtml(p.processes)}</td></tr>`).join('')
        : `<tr><td colspan="${COLUMN_COUNT}" class="empty">Không có socket nào đang lắng nghe.</td></tr>`;
    } catch (error) {
      rowsEl.innerHTML = `<tr><td colspan="${COLUMN_COUNT}" class="empty is-danger">Không đọc được danh sách cổng: ${escapeHtml(error.message)}</td></tr>`;
    } finally {
      reloadEl.disabled = false;
    }
  }

  reloadEl.addEventListener('click', load);
  return { onShow: load, onKey: () => false };
}
