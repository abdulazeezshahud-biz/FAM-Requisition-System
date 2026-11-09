# FAM Requisition System — Handover

Purchase requisition & approval system for the **Football Association of Maldives**.
This document is the authoritative guide for taking ownership of the system and
running it on your own infrastructure.

- **Version handed over:** 2026-11-08
- **Frontend:** one self-contained `index.html` (installable PWA), served as a static site.
- **Backend:** [PocketBase](https://pocketbase.io) **0.39.5** (single binary + a hooks file).
- **No build step, no Node runtime in production.** The only use of Node is the one-off
  provisioning script that creates the database schema.

---

## 1. What's in this package

| Path | What it is |
|---|---|
| `index.html` | The entire application — UI, logic, offline sync, PWA. Edit `window.PB_URL` near the top to point at your backend. |
| `scripts/provision-pb.mjs` | One-off schema + seed script. Creates all collections, rules, and the starter users/settings. Idempotent. |
| `pb_hooks/fam.pb.js` | PocketBase server hook — server-side numbering, audit trail, approval-link sync, login rate-limiting, AI quote parsing, Odoo posting. |
| `docker-compose.yml`, `Caddyfile`, `Dockerfile.pocketbase`, `.env.example`, `*-entrypoint.sh` | **Turnkey Docker bundle** — PocketBase + frontend + automatic-HTTPS reverse proxy, one command (section 4, Option A). |
| `Dockerfile`, `nginx.conf`, `fam-security-headers.conf` | Container build for the frontend (nginx). Used by the bundle, or standalone on any static host. |
| `config.js` | Runtime backend-URL config (auto-generated in Docker; editable for manual installs). |
| `manifest.json`, `sw.js`, `icon-*.png`, `apple-touch-icon.png`, `icon.svg` | PWA assets (installable app, offline shell). |
| `manual.html`, `manual.pdf` | End-user manual (every feature by role and workflow). Served at `/manual.html`. |
| `robots.txt` | Keeps the app out of search indexes. |
| `README.md` | Short developer notes (some references are internal to the original build). |
| `HANDOFF.md` | **This file.** |

> **Not included (by design):** credential files and any `.git` history. You generate
> your own credentials on first provision (section 4).

---

## 2. Architecture in one minute

- The **frontend** is a static single-page app. In production it is just files on a web
  server. It talks to PocketBase over HTTPS; it never needs a server-side runtime of its own.
- The **backend** is one PocketBase process holding the database (`pb_data/`), the file
  uploads, and the API. All collections are prefixed `req_`.
- **Offline-first:** the app keeps a local copy and syncs changes to PocketBase. A user can
  keep working briefly without a connection; changes flush when it returns.
- **Approval links:** an approver receives a `?approve=<token>` link and approves/rejects
  **with no login**, from any device. This is safe because token-scoped API rules only expose
  that one requisition's decision fields while it is still pending.
- **The server hook (`fam.pb.js`) is required for production.** It assigns requisition
  numbers atomically, writes the audit trail, enforces who may change payment/approval
  fields, rate-limits logins, and powers the optional AI and Odoo features.

---

## 3. Prerequisites for self-hosting

- A Linux server (or any host) that can run the PocketBase binary and serve static files.
- A domain (or two subdomains) with HTTPS — e.g. `req.yourdomain.com` for the app and
  `pb.yourdomain.com` for PocketBase (the Docker option needs just one). HTTPS is required —
  the installable app (service worker) and secure sign-in depend on it.
- **Node.js 18+** on any machine (can be your laptop) — used **once** to run the provisioning
  script against your PocketBase URL.
- The PocketBase binary for your OS: download **v0.39.5** from
  <https://github.com/pocketbase/pocketbase/releases/tag/v0.39.5>.

---

## 4. Deploy from scratch

Two supported paths. **Option A (Docker) is the recommended, near-turnkey route** — one
command brings up PocketBase, the frontend, and automatic HTTPS. **Option B** is a manual
install on any host if you don't use Docker.

---

### Option A — Docker Compose (recommended)

Requirements: a server with **Docker + Docker Compose**, a **domain** with its DNS A-record
pointed at the server, and ports **80** and **443** open. (Docker provides everything else —
no separate PocketBase binary or Node needed.)

```bash
# 1. Configure
cp .env.example .env
#    edit .env: set DOMAIN, PB_ADMIN, PB_ADMIN_PASS (strong password)

# 2. Start PocketBase + frontend + HTTPS reverse proxy
docker compose up -d --build

# 3. Create the schema + starter users (run once)
docker compose run --rm provision
```

That's it. Open `https://<your-domain>` and sign in with a starter account from the generated
`fam-req-credentials.txt` (written to the project folder on the host). The PocketBase admin
dashboard is at `https://<your-domain>/_/`.

How it fits together:

- **One domain** serves everything. Caddy routes `/api/*` and `/_/*` to PocketBase and
  everything else to the frontend, so there is **no CORS to configure** and no separate
  `pb.` subdomain. Caddy obtains and renews HTTPS certificates automatically (Let's Encrypt).
- The **superuser** is created automatically from `.env` on first start.
- The **hook** (`pb_hooks/fam.pb.js`) is baked into the PocketBase image.
- The **backend URL** is injected into the frontend automatically — you never edit `index.html`.
- **Data** lives in the `pb_data` Docker volume — this is your database and all uploads. Back
  it up (section 7). To test locally first, set `DOMAIN=localhost` (Caddy issues an internal
  cert; your browser will warn — that's expected for local testing).

To update later: pull/replace the files and `docker compose up -d --build`. To re-run the
provisioner against live data without re-seeding users, add `SEED=0` to `.env` first.

Optional AI/Odoo features: set `ANTHROPIC_API_KEY` / `ODOO_API_KEY` in `.env` and
`docker compose up -d` again (section 6).

> Then jump to **section 5 (First-run checklist)**. The manual steps below are only for
> non-Docker hosts.

---

### Option B — Manual install (any host)

Use this if you are not running Docker.

### B.1 Start PocketBase and create the superuser

```bash
# on your server, in a working directory you control
./pocketbase serve --http=0.0.0.0:8090
```

Put PocketBase behind your reverse proxy / TLS so it is reachable at `https://pb.yourdomain.com`.
Then create the admin (superuser) account — either in the dashboard at
`https://pb.yourdomain.com/_/`, or on the CLI:

```bash
./pocketbase superuser create admin@yourdomain.com "a-strong-password"
```

Keep `pb_data/` on persistent storage — **that directory is your whole database and all
uploads.** Back it up (section 7).

### B.2 Install the server hook

Copy `pb_hooks/fam.pb.js` into PocketBase's `pb_hooks/` folder (next to the binary / in the
data dir), then restart PocketBase. On restart you should see it load with no errors.

### B.3 Create the schema and starter data

From any machine with Node, pointed at your PocketBase:

```bash
PB_URL=https://pb.yourdomain.com \
PB_ADMIN=admin@yourdomain.com \
PB_ADMIN_PASS='a-strong-password' \
node scripts/provision-pb.mjs
```

This is **idempotent** — safe to re-run. It:

- creates the collections `req_users`, `req_vendors`, `req_requisitions`, `req_approvals`,
  `req_settings`, `req_audit` and applies their security rules;
- seeds default system settings (approval chain, tax rates, numbering, lists);
- on the **first** run, seeds a set of starter app users and vendors and writes their
  generated passwords to **`fam-req-credentials.txt`** in the repo folder.

> Pass `SEED=0` to skip seeding users/vendors (use when re-running against a database that
> already has real data — it still updates schema and rules).

**`fam-req-credentials.txt` contains live passwords. Hand each login to its user over a
secure channel, then delete the file.** Users can change their own passwords, and an admin
can reset any password from the in-app **Admin → Users** tab.

### B.4 Point the frontend at your backend

In `index.html`, near the top, set your PocketBase URL:

```js
window.PB_URL = (location.hostname === "127.0.0.1" || location.hostname === "localhost")
  ? location.origin
  : "https://pb.yourdomain.com";   // ← your PocketBase URL
```

(It currently ships as `""`, which runs the app in standalone demo mode with no backend.)

### B.5 Serve the frontend

Serve the repo's static files from `https://req.yourdomain.com` over HTTPS. Any static host
works (nginx, Caddy, Netlify, S3+CDN, …). Two things the web server must do:

- serve `sw.js` with `Service-Worker-Allowed: /` and no-cache, so PWA updates roll out;
- send the security headers in `fam-security-headers.conf` (Content-Security-Policy,
  Permissions-Policy, and the other hardening headers).

The included `Dockerfile` + `nginx.conf` already do both.

**CORS:** if PocketBase is on a **different** origin than the app (e.g. `pb.yourdomain.com` vs
`req.yourdomain.com`), add the app's origin to PocketBase (Dashboard → Settings). If the app
can log in but not load data, check this first. The Docker option (A) avoids this by putting
both under one domain.

---

## 5. First-run checklist (as the admin)

1. Sign in at the app with the seeded `admin` account (`fam-req-credentials.txt`).
2. **Change the seeded passwords** (Admin → Users → Reset password) and distribute real logins.
3. Open **Admin** and review each tab — all settings are live and editable here:
   - **Numbering** — set the next requisition number to continue your existing paper sequence.
   - **Tax** — GST / TGST rates and how many quotations a purchase needs.
   - **Approval chain** — the signing order and who can sign each step (add/remove/reorder).
   - **Low-value rule** — optional: below an amount, fewer quotes + fewer approvers.
   - **Categories & lists** — vendor categories, currencies (star = default), departments.
   - **Odoo** — optional accounting integration (section 6).
   - **Users** — accounts, roles, password resets.
4. Register your vendors (**Vendors → Register vendor**) or let finance add them as needed.
5. Create a test requisition end-to-end (create → approve via link → mark paid) to confirm the
   chain and audit trail work on your server.

---

## 6. Optional server-side features (environment variables on PocketBase)

These are **off** unless you set the matching environment variable on the PocketBase process.
None of these keys ever reach the browser.

| Feature | Env var | Notes |
|---|---|---|
| AI quote extraction (reads a PDF/photo quote and fills vendor/amount) | `ANTHROPIC_API_KEY` | Your Anthropic API key. Model override via `FAM_AI_MODEL` (default `claude-opus-4-8`). |
| Post a paid requisition to Odoo as a vendor bill | `ODOO_API_KEY` | Your Odoo API key. The connection URL/DB/username/tax-ids/journal are set in **Admin → Odoo** (not secret, stored in settings). |

After setting an env var, restart PocketBase. Test Odoo from **Admin → Odoo → Test connection**.

---

## 7. Operate & maintain

- **Backups:** `pb_data/` (the `pb_data` volume in Docker) holds the database and every
  uploaded file. **Don't back it up by copying the folder while PocketBase is running** — a
  copy taken mid-write can be corrupt. Use PocketBase's built-in backups instead: in the
  dashboard (`/_/`) go to **Settings → Backups**, turn on **scheduled backups** (e.g. nightly),
  and either point them at S3-compatible storage or copy the finished backup files (in
  `pb_data/backups/`) off the server. Restore from the same screen. Test a restore once.
- **Update the frontend:** edit `index.html` (or other assets) and redeploy the static files.
  **When you change any app-shell asset, bump the `CACHE` constant in `sw.js`** (currently
  `fam-req-v7`) or installed PWA clients keep serving the old version.
- **Update the hook:** replace `pb_hooks/fam.pb.js` and restart PocketBase.
- **Change the schema/rules:** edit `scripts/provision-pb.mjs` and re-run it with `SEED=0`.

---

## 8. Roles & permissions

Set per user in **Admin → Users** (`role` + `approverRoles`):

| Role | Can |
|---|---|
| `viewer` | See requisitions and reports. |
| `approver` | The above + sign the chain steps listed in their `approverRoles`. |
| `finance` | The above + register vendors, mark paid, record goods received, post to Odoo, renumber. |
| `admin` | Everything + the Admin tab (settings, users). |

Approval **links** need no account at all — the token in the link authorizes exactly one
decision on one requisition.

---

## 9. Known gaps / not built

These were scoped out or need configuration you provide:

- **Emailing approval links** — the system generates the links; it does not send email. Wire
  up SMTP, or distribute links by your own channel (copy-link is in the app).
- **Budget-line ceilings** — budget lines are recorded and reported, but there is no hard
  per-line spending cap.
- The included Odoo integration creates **vendor bills**; it does not sync payments back from Odoo.

---

## 10. Sign-off

The FAM Requisition System is delivered as the source in this package, deployable on your own
infrastructure per the steps above. On a correctly configured host it provides: role-based
requisition creation and approval, no-login approval links, server-assigned numbering, a full
audit trail, GST/TGST, vendor register, configurable approval chains and low-value rules,
reporting with CSV/PDF export, an installable mobile PWA, and optional AI quote extraction and
Odoo posting.

Build and functionality were verified against PocketBase 0.39.5 (backend test suite and
in-browser end-to-end checks). Ongoing hosting, backups, credential management, and any future
changes are the owner's responsibility from handover.

**Handed over:** 2026-11-08.
