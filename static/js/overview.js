import { LineChart } from './chart.js';
import { bytes, duration, escapeHtml, percent, rate } from './fmt.js';

const HOT_PERCENT = 85;
const READOUT_KEYS = ['cpu', 'mem', 'swap', 'net', 'disk', 'uptime'];
const READOUT_LABELS = { cpu: 'CPU', mem: 'RAM', swap: 'Swap', net: 'Mạng', disk: 'Đĩa I/O', uptime: 'Đã chạy' };
const CHART_SPECS = [
  { id: 'cpu', title: 'CPU', series: [{ key: 'cpu', colorToken: '--amber', label: 'dùng' }], fixedMax: 100, unit: 'pct' },
  { id: 'mem', title: 'RAM', series: [{ key: 'mem', colorToken: '--amber', label: 'dùng' }], fixedMax: 100, unit: 'pct' },
  { id: 'net', title: 'Mạng', series: [{ key: 'rx', colorToken: '--amber', label: 'nhận' }, { key: 'tx', colorToken: '--teal', label: 'gửi' }], unit: 'rate' },
  { id: 'disk', title: 'Đĩa', series: [{ key: 'rd', colorToken: '--amber', label: 'đọc' }, { key: 'wr', colorToken: '--teal', label: 'ghi' }], unit: 'rate' },
];

const meterHtml = (fraction) => {
  const clamped = Math.max(0, Math.min(1, fraction || 0));
  const hotClass = clamped * 100 >= HOT_PERCENT ? ' is-hot' : '';
  return `<span class="meter${hotClass}"><span style="transform: scaleX(${clamped})"></span></span>`;
};

function readoutHtml(key) {
  return `<div class="readout" data-readout="${key}">
    <span class="label">${READOUT_LABELS[key]}</span>
    <div class="readout__value"><div class="skel" style="height: 30px; width: 70%"></div></div>
    <div class="readout__sub"></div>
  </div>`;
}

function chartHtml({ id, title, series }) {
  const legend = series.map((s) => `<span><i style="background: var(${s.colorToken})"></i>${s.label}</span>`).join('');
  return `<figure class="chart" data-chart="${id}" style="margin: 0">
    <figcaption class="chart__head"><span class="label">${title}</span><span class="chart__now"></span>
      <span class="chart__legend">${legend}</span></figcaption>
    <div class="chart__plot"><canvas></canvas></div>
  </figure>`;
}

function buildSkeleton(root) {
  root.innerHTML = `<div class="ov">
    <div class="ov__readouts">${READOUT_KEYS.map(readoutHtml).join('')}</div>
    <div class="ov__charts">${CHART_SPECS.map(chartHtml).join('')}</div>
    <div class="ov__lower">
      <div class="block"><span class="label">Từng lõi CPU</span><div data-slot="cores"><div class="skel"></div></div></div>
      <div class="block"><span class="label">Phân vùng đĩa</span><div data-slot="disks"><div class="skel"></div></div></div>
    </div>
  </div>`;
}

function readoutValues(state) {
  const { cpu, mem, net, disk_io: diskIo, loadavg, host, uptime_sec: uptimeSec } = state;
  const memFraction = mem.total ? mem.used / mem.total : 0;
  const swapFraction = mem.swap_total ? mem.swap_used / mem.swap_total : 0;
  return {
    cpu: [percent(cpu.total), `${host.cores} lõi · tải ${loadavg.map((v) => v.toFixed(2)).join(' ')}`, cpu.total / 100],
    mem: [`${bytes(mem.used, 0)}<small>/ ${bytes(mem.total, 0)}</small>`, `còn ${bytes(mem.available)} · cache ${bytes(mem.cache)}`, memFraction],
    swap: mem.swap_total
      ? [`${bytes(mem.swap_used, 0)}<small>/ ${bytes(mem.swap_total, 0)}</small>`, percent(swapFraction * 100), swapFraction]
      : ['tắt', 'không có swap', null],
    net: [`<span class="is-amber">↓</span>${rate(net.total[0])}`, `↑ ${rate(net.total[1])}`, null],
    disk: [`<span class="is-amber">R</span> ${rate(diskIo.total[0])}`, `W ${rate(diskIo.total[1])}`, null],
    uptime: [duration(uptimeSec), `kernel ${escapeHtml(host.kernel)}`, null],
  };
}

export function createOverview(root) {
  buildSkeleton(root);
  const readoutEls = Object.fromEntries(READOUT_KEYS.map((key) => {
    const el = root.querySelector(`[data-readout="${key}"]`);
    return [key, { value: el.querySelector('.readout__value'), sub: el.querySelector('.readout__sub') }];
  }));
  const coresSlot = root.querySelector('[data-slot="cores"]');
  const disksSlot = root.querySelector('[data-slot="disks"]');
  let charts = null;

  function ensureCharts(capacity) {
    if (charts) return charts;
    charts = CHART_SPECS.map((spec) => {
      const figure = root.querySelector(`[data-chart="${spec.id}"]`);
      const formatMax = spec.unit === 'pct' ? (v) => `${v}%` : rate;
      return { spec, nowEl: figure.querySelector('.chart__now'),
        chart: new LineChart(figure.querySelector('canvas'), { series: spec.series, fixedMax: spec.fixedMax ?? null, formatMax, capacity }) };
    });
    return charts;
  }

  function renderReadouts(state) {
    for (const [key, [value, sub, fraction]] of Object.entries(readoutValues(state))) {
      readoutEls[key].value.innerHTML = value;
      readoutEls[key].sub.innerHTML = fraction === null ? sub : `${sub}${meterHtml(fraction)}`;
    }
  }

  function renderCharts(state) {
    const latest = state.history.at(-1);
    for (const { spec, nowEl, chart } of ensureCharts(state.history_capacity)) {
      chart.update(state.history);
      if (!latest) continue;
      nowEl.textContent = spec.series.map((s) => (spec.unit === 'pct' ? percent(latest[s.key]) : rate(latest[s.key]))).join(' / ');
    }
  }

  function renderLower(state) {
    coresSlot.innerHTML = state.cpu.cores.map((value, index) =>
      `<div class="core-row"><span class="muted">cpu${index}</span>${meterHtml(value / 100)}<span class="num">${percent(value)}</span></div>`).join('');
    disksSlot.innerHTML = state.disks.length ? state.disks.map((disk) =>
      `<div class="disk-row"><span title="${escapeHtml(disk.device)} · ${escapeHtml(disk.fstype)}">${escapeHtml(disk.mount)}</span>
        ${meterHtml(disk.used / disk.total)}
        <span class="muted">${bytes(disk.used)} / ${bytes(disk.total)}</span></div>`).join('')
      : '<p class="empty">Không thấy phân vùng ext4/xfs/btrfs nào được mount.</p>';
  }

  return {
    render(state) {
      renderReadouts(state);
      renderCharts(state);
      renderLower(state);
    },
  };
}
