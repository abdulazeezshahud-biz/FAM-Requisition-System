# fam-req

Purchase requisition & approval system for the Football Association of Maldives.
Single-page app backed by PocketBase — same architecture as nimmin-hr.

## Architecture

- **Frontend:** this repo, served as a static site via nginx (Coolify auto-deploys on push to `main`).
- **Backend:** a dedicated PocketBase instance on the FAM VPS (separate from any other PocketBase). Set its URL in `window.PB_URL` at the top of `index.html`. Collections are prefixed `req_`.
- **Approval links:** approvers get a `?approve=<token>` link — they see the requisition and approve/reject with **no login**, from any device. Token-scoped API rules on `req_approvals` make this safe; `pb_hooks/fam.pb.js` (optional but recommended) syncs decisions into the requisition chain instantly server-side. Without the hook the app reconciles decisions the next time any signed-in user opens it.

## Collections

| Collection | Type | Purpose |
|---|---|---|
| `req_users` | auth | App accounts. Sign in with username or email. Roles: viewer / approver / finance / admin. `approverRoles` controls which chain steps a user can sign. |
| `req_vendors` | base | Vendor register (bank details, categories). |
| `req_requisitions` | base | One record per requisition. Items/quotes/chain stored as JSON; quote documents in the `attachments` file field (`fileMap` maps app file ids → stored filenames). |
| `req_approvals` | base | One record per issued approval link. Anonymous read/update is allowed **only** with `?t=<token>` matching the record, only while pending, and only on the decision fields. |

## Deploy / operate

1. **Schema:** `PB_URL=<pocketbase url> PB_ADMIN=<superuser> PB_ADMIN_PASS=<pass> node scripts/provision-pb.mjs`
   Idempotent — creates collections, re-applies rules, seeds the FAM users/vendors on first run and writes generated passwords to `fam-req-credentials.txt` (git-ignored — distribute, then delete).
2. **Hook:** copy `pb_hooks/fam.pb.js` into the PocketBase container's `pb_hooks/` (Coolify → pocketbase → Terminal) and restart PocketBase.
3. **Frontend:** Coolify app pointed at this repo (Dockerfile build), domain e.g. `req.nimmin.online`. Push to `main` to deploy.

## Local development

Open `index.html` in a browser with `window.PB_URL = ""` (top of the file) for standalone demo mode with seeded data. Point it at any PocketBase instance to test live mode — run `node scripts/provision-pb.mjs` against it first.

## Editing

| File | Purpose |
|---|---|
| `index.html` | The entire app — config (`window.CONFIG`), UI, logic, and the PocketBase live-mode block at the bottom |
| `scripts/provision-pb.mjs` | Schema + seed provisioning (idempotent) |
| `pb_hooks/fam.pb.js` | Server-side approval sync + `/api/fam/approval-state` |
| `Dockerfile`, `nginx.conf` | Container build for Coolify |

Org name, GST rate, departments and the approval chain are configured in `window.CONFIG` at the top of `index.html`.

## License

Private — Football Association of Maldives internal use only.
