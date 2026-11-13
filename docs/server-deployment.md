# Server deployment

Card Studio runs at **https://cards.demuxnetworks.com** on `ssh ubuntu-server`.
It has a new, independent library. The workstation library and generation queue remain local.

Both services start on boot:

```bash
sudo systemctl status card-studio cloudflared-card-studio
sudo journalctl -u card-studio -u cloudflared-card-studio -n 50
sudo systemctl restart card-studio
```

The application lives at `/home/jseger/magic-cards/catdog` and binds only to
`127.0.0.1:4317`. Its separate Cloudflare tunnel is named `card-studio`, ID
`183e5a20-92ae-40fa-aae9-410782275b8c`. The existing Home Assistant tunnel is unchanged.

HTTP Basic authentication protects every page, asset and API, including bootstrap
and generation. Browser writes additionally require the application request token
and the configured HTTPS origin. Failed credentials are limited to eight attempts
per client and forty overall in ten minutes. Authentication is checked before any
application handler. Cloudflare terminates HTTPS and forwards through its outbound
tunnel; the app does not trust arbitrary forwarded hosts or schemes.

The username and public origin are in `~/.config/card-studio/server.env` on the
server. The password and tunnel token are separate files there, readable only by
their owner. To change the password, update `server-password` and restart Card
Studio. Local deployment login details are in
`/home/jseger/.config/card-studio/server-login.txt` on the workstation. Credentials
are not stored in the project or this document.

Node 24 is installed under `/usr/local/lib/card-studio-node`. Python 3.10 and its
virtual environment preserve the renderer's pinned Pillow dependency. The runtime
is installed under `/usr/local/lib/card-studio-python` so the generation sandbox
can mount it read-only without exposing the user's home directory.

Codex and Grok use separate credential directories under
`~/.local/share/card-studio-auth`, selected using `CODEX_HOME` and `GROK_HOME`.
Their existing subscription logins were transferred through SSH; renew them on
the server if the provider expires or revokes the sessions. These credentials are
separate from the server's existing CI Codex configuration. Isolated jobs copy only
authentication files and the image-generation skill into their temporary homes.

Source updates should exclude `library/`, `.venv/`, `output/` and credentials.
Back up the server's `library/` before any database migration. Stop the service or
use SQLite's backup API when copying its database. Never replace the server
library with the workstation library unless explicitly migrating data.
