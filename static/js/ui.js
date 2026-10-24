const NOTICE_MS = 6000;
const NOTICE_ERROR_MS = 12000;

const noticeEl = document.getElementById('notice');
const dialogEl = document.getElementById('confirm-dialog');
const dialogTitleEl = document.getElementById('confirm-title');
const dialogBodyEl = document.getElementById('confirm-body');
const dialogOkEl = document.getElementById('confirm-ok');

let noticeTimer = 0;

export function showNotice(message, kind = 'ok') {
  clearTimeout(noticeTimer);
  noticeEl.textContent = message;
  noticeEl.dataset.kind = kind;
  noticeEl.hidden = false;
  noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, kind === 'error' ? NOTICE_ERROR_MS : NOTICE_MS);
}

noticeEl.addEventListener('click', () => { noticeEl.hidden = true; });

/** Resolves true only when the user presses the confirm button. Esc/backdrop/cancel all resolve false. */
export function confirmAction({ title, body, confirmLabel }) {
  dialogTitleEl.textContent = title;
  dialogBodyEl.textContent = body;
  dialogOkEl.textContent = confirmLabel;
  dialogEl.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialogEl.addEventListener('close', () => resolve(dialogEl.returnValue === 'ok'), { once: true });
    dialogEl.showModal();
    dialogOkEl.focus();
  });
}

export const isDialogOpen = () => dialogEl.open;

/** Summarises a remote command payload ({ok, exit_code, stdout, stderr}) as one notice. */
export function reportCommand(label, payload) {
  if (payload.ok) {
    showNotice(`${label}: xong${payload.stdout.trim() ? `\n${payload.stdout.trim()}` : ''}`);
    return;
  }
  const detail = (payload.stderr || payload.stdout || '').trim() || 'không có thông báo lỗi';
  showNotice(`${label}: thất bại (mã ${payload.exit_code})\n${detail}`, 'error');
}

export function skeletonRows(columnCount, rowCount = 8) {
  const cells = '<td><div class="skel"></div></td>'.repeat(columnCount);
  return `<tr>${cells}</tr>`.repeat(rowCount);
}
