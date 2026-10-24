const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const KIB = 1024;
const SEC_PER_MIN = 60;
const SEC_PER_HOUR = 3600;
const SEC_PER_DAY = 86400;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function bytes(value, digits = 1) {
  let scaled = Math.max(0, value || 0);
  let unitIndex = 0;
  while (scaled >= KIB && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= KIB;
    unitIndex += 1;
  }
  const shown = unitIndex === 0 ? String(Math.round(scaled)) : scaled.toFixed(scaled >= 100 ? 0 : digits);
  return `${shown} ${BYTE_UNITS[unitIndex]}`;
}

export const rate = (bytesPerSec) => `${bytes(bytesPerSec)}/s`;

export const percent = (value) => `${(value || 0).toFixed(1)}%`;

export function duration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(sec / SEC_PER_DAY);
  const hours = Math.floor((sec % SEC_PER_DAY) / SEC_PER_HOUR);
  const minutes = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN);
  if (days > 0) return `${days}n ${hours}g`;
  if (hours > 0) return `${hours}g ${minutes}p`;
  if (minutes > 0) return `${minutes}p ${sec % SEC_PER_MIN}s`;
  return `${sec}s`;
}

export const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

export const clockTime = (epochSec) => new Date(epochSec * 1000).toLocaleTimeString('vi-VN', { hour12: false });

/** Wraps lines that look like failures so they stand out in log output. */
export function highlightLog(text) {
  const failurePattern = /\b(error|fail(ed|ure)?|denied|fatal|panic|critical|refused)\b/i;
  return escapeHtml(text)
    .split('\n')
    .map((line) => (failurePattern.test(line) ? `<span class="hl-bad">${line}</span>` : line))
    .join('\n');
}
