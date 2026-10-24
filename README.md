# Oracle Panel

Task manager trên web cho một VM Linux: CPU/RAM/mạng/đĩa theo thời gian thực, kill tiến trình, start/stop dịch vụ systemd, xem cổng đang mở, đọc journal, chạy lệnh shell.

Có 2 cách dùng.

## 1. Online: giao diện trên GitHub Pages

```
https://wanfuc901.github.io/oracle-panel/   (HTML/JS tĩnh, chính là thư mục static/)
        │ fetch + Bearer token
        ▼
https://panel-api.hoangphuc.store           (Cloudflare tunnel)
        ▼
127.0.0.1:47620 trên server                 (panel.py, mode "local", systemd: oracle-panel)
```

- Đăng nhập bằng mật khẩu và mã 2FA (TOTP). Sai 5 lần thì IP bị khoá 15 phút; tính trên mọi IP, sai 20 lần thì khoá toàn bộ.
- API chỉ nhận CORS từ `https://wanfuc901.github.io` và chỉ nghe trên `127.0.0.1`. Bên ngoài chỉ vào được qua tunnel.
- Token đăng nhập nằm trong `sessionStorage`, đóng tab là mất.

**Đổi mật khẩu hoặc 2FA** (chạy trên server):

```bash
python3 ~/oracle-panel/app/setup_auth.py ~/.config/oracle-panel/secrets.json --keep-totp   # chỉ đổi mật khẩu
python3 ~/oracle-panel/app/setup_auth.py ~/.config/oracle-panel/secrets.json               # đổi cả 2FA
sudo systemctl restart oracle-panel
```

**Deploy:** push lên `main` là xong.

- `static/**` → workflow `pages.yml` → GitHub Pages.
- `*.py`, `deploy/**` → workflow `deploy-server.yml` → nén tar, gửi qua SSH tới server. Deploy key chỉ chạy được `receive.sh`. Script này kiểm tra file, thay bản mới, restart rồi health check; lỗi thì tự quay về bản cũ.
- Secrets của repo: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_TARGET`.

Log của server: `~/.local/state/oracle-panel/panel.log` (mọi lần đăng nhập, kill, systemctl, exec đều được ghi lại) và `journalctl -u oracle-panel`.

## 2. Desktop: chạy trên máy Windows qua SSH

```
copy config.example.json config.json   # điền host, user, key_path
OraclePanel.cmd                        # cài paramiko nếu thiếu, mở http://127.0.0.1:47620
```

Bản desktop không cần đăng nhập: token phiên được nhúng vào trang, và server chỉ nghe trên `127.0.0.1`.
