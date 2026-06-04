# Shared To-Do for Home Screens

A household to-do list with **priority** and **deadlines** that stays in sync across
your Pi display and everyone's phones. Touch a task on the Pi screen to check it off;
add/edit/assign tasks from any phone. Everything points at one small service running
on your Pi.

```
   Pi touchscreen                 Phones (home-screen web app)
   [Home Screens plugin] <──┐   ┌──> [todo web app]
                            │   │
                            ▼   ▼
                    ┌───────────────────┐
                    │  todo-server.mjs  │  ← single source of truth (todos.json)
                    │   on your Pi      │
                    └───────────────────┘
```

Why a separate service? A Home Screens **plugin** runs sandboxed in the browser and
can talk to an allowed URL through the host proxy, but it can't own shared state by
itself. The little service is what lets the Pi screen and both phones see the same
list and update each other.

---

## What's in the box

```
todo-sync/
  server/
    todo-server.mjs        # the sync service (Node, zero dependencies)
    public/index.html      # the phone web app, served by the service
  plugin/
    manifest.json          # Home Screens plugin manifest
    dist/bundle.js          # ready-to-load plugin (no build needed)
    src/index.tsx          # optional TSX source if you want to edit in JSX
    build.sh               # optional rebuild script (esbuild)
```

---

## Part 1 — Run the service on the Pi

You already have Node on the Pi (Home Screens needs it). From the `server/` folder:

```bash
node todo-server.mjs
```

You'll see it print the URL. Note your Pi's LAN IP (`hostname -I` gives it, e.g.
`192.168.1.50`). The service listens on port **8787** by default.

### Make it start on boot (systemd)

Copy `server/` somewhere stable (e.g. `/home/pi/todo-sync`), then:

```bash
sudo tee /etc/systemd/system/todo-sync.service >/dev/null <<'EOF'
[Unit]
Description=Shared To-Do sync service
After=network-online.target

[Service]
ExecStart=/usr/bin/node /home/pi/todo-sync/todo-server.mjs
WorkingDirectory=/home/pi/todo-sync
Restart=always
User=pi
# Optional: require a shared secret on every request
# Environment=SYNC_TOKEN=pick-a-long-random-string
# Environment=PORT=8787

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now todo-sync
systemctl status todo-sync        # check it's running
```

The list is saved to `todos.json` next to the script, so it survives restarts.

---

## Part 2 — Put the app on your phones

On each phone, open `http://<pi-ip>:8787/` (e.g. `http://192.168.1.50:8787/`).

- **iPhone:** Share → *Add to Home Screen*
- **Android:** menu → *Add to Home screen / Install app*

It then opens full-screen like a normal app. Add tasks with the bar at the bottom;
tap a task to edit its priority, due date, and who it's assigned to; tap the circle to
check it off. It auto-refreshes every few seconds.

---

## Part 3 — Install the plugin on the Pi display

The plugin is pre-built — no toolchain required. Two ways to load it:

### Quick way (dev mode, great for trying it)

1. Serve the `plugin/` folder over HTTP. From inside `plugin/`:
   ```bash
   npx --yes serve -l 5555 .      # or: python3 -m http.server 5555
   ```
   (It must expose `manifest.json` and `dist/bundle.js` at the root.)
2. In the Home Screens **editor**, open the plugin browser's dev panel and register
   `http://<pi-ip>:5555`. It hot-reloads on changes.

### Permanent way (install from a tarball URL)

1. Make a tarball with `manifest.json` and `dist/` at its root:
   ```bash
   cd plugin && tar czf todo-sync-1.0.0.tar.gz manifest.json dist
   ```
2. Host it anywhere the Pi can reach over HTTPS (a GitHub release works well).
3. In the editor's plugin browser → **Install from URL…** → paste the tarball URL.

Either way, **Shared To-Do** then appears in the editor palette under *Personal*.
Drag it onto a screen.

### Configure the module

In the module's settings (right-hand panel):

- **Sync service URL** → `http://<pi-ip>:8787` (use the IP, **not** `localhost` — the
  plugin proxy blocks loopback). The bundled `allowedDomains: ["*"]` + `localNetwork`
  permission let it reach any device on your home network without editing anything.
- **Sort, priority colors, due dates, assignee, auto-hide completed** — all toggles.

That's it. Tap a task on the screen and watch it check off on both phones, and vice
versa.

---

## Optional: a shared secret

For a home LAN this is usually unnecessary. If you want one:

1. Set `SYNC_TOKEN=some-long-random-string` on the service (uncomment in the systemd
   unit, then `sudo systemctl restart todo-sync`).
2. In the **phone app** → gear icon → paste the same token.
3. In the **plugin** → the module's *Sync token* secret (editor settings) → same value.

Set it in all three places or none — a mismatch returns 401.

---

## Optional: use it away from home

The default setup is LAN-only (phones must be on home Wi-Fi to update). To reach it
from anywhere, the simplest safe option is **Tailscale**: install it on the Pi and
your phones, then use the Pi's Tailscale IP (a `100.x.x.x` address) as both the phone
URL and the plugin's Sync service URL. No ports exposed to the internet.

If you'd rather host the list in the cloud instead of on the Pi, the same `todo-server.mjs`
runs on any Node host; then set the plugin's `allowedDomains` in `manifest.json` to that
specific domain (and you can drop the `localNetwork` permission and the `"*"`).

---

## Editing the plugin (optional)

`dist/bundle.js` is hand-written plain JS and works as-is. If you'd rather work in
JSX/TypeScript, edit `src/index.tsx` and run `./build.sh` (needs `npx esbuild`,
one-time download) to regenerate `dist/bundle.js`.

## Data model (per task)

```json
{
  "id": "uuid",
  "text": "Buy quarter cow from the farm",
  "completed": false,
  "completedAt": null,
  "priority": "high",        // "high" | "med" | "low"
  "due": "2026-06-05",       // YYYY-MM-DD, or null
  "assignee": "Hunter",
  "createdAt": "…",
  "updatedAt": "…"
}
```

Edits are last-write-wins per field, which is plenty for a two-person household list.
