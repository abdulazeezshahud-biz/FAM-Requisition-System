// Provision the FAM Requisition System schema on a PocketBase instance.
//
// Creates (idempotently - safe to re-run, re-applies rules on existing
// collections without touching data):
//   req_users        auth  - app accounts (username or email + password)
//   req_vendors      base  - vendor register
//   req_requisitions base  - requisitions (items/quotes/chain as JSON,
//                            quote documents in the `attachments` file field)
//   req_approvals    base  - one record per magic approval link; anonymous
//                            token-scoped read/update via @request.query.t
//
// Seeds the FAM user accounts + vendor register on first run (skips any that
// already exist) and writes generated passwords to fam-req-credentials.txt.
//
// Usage:
//   node scripts/provision-pb.mjs
// Env:
//   PB_URL        e.g. https://pb.nimmin.online   (default http://127.0.0.1:8090)
//   PB_ADMIN      superuser email
//   PB_ADMIN_PASS superuser password
//   SEED          "0" to skip seeding users/vendors (default: seed)

import { writeFileSync } from "node:fs";

const PB = (process.env.PB_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
const ADMIN = process.env.PB_ADMIN || "";
const PASS = process.env.PB_ADMIN_PASS || "";
const DO_SEED = process.env.SEED !== "0";

if (!ADMIN || !PASS) {
  console.error("Set PB_ADMIN and PB_ADMIN_PASS env vars (PocketBase superuser).");
  process.exit(1);
}

let TOKEN = "";
async function api(method, path, body) {
  const res = await fetch(PB + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: TOKEN } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* raw */ }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}

async function login() {
  try {
    const r = await api("POST", "/api/collections/_superusers/auth-with-password", { identity: ADMIN, password: PASS });
    TOKEN = r.token;
    console.log("Authenticated (PocketBase 0.23+).");
  } catch (e) {
    // legacy fallback
    const r = await api("POST", "/api/admins/auth-with-password", { identity: ADMIN, password: PASS });
    TOKEN = r.token;
    console.log("Authenticated (PocketBase <=0.22 admin API).");
  }
}

const AUTHED = '@request.auth.collectionName = "req_users"';
const ADMIN_ONLY = '@request.auth.collectionName = "req_users" && @request.auth.role = "admin"';
const FINANCE_OR_ADMIN = '@request.auth.collectionName = "req_users" && (@request.auth.role = "finance" || @request.auth.role = "admin")';

const COLLECTIONS = [
  {
    name: "req_users",
    type: "auth",
    fields: [
      { name: "username", type: "text", required: true, min: 2, max: 60 },
      { name: "name", type: "text", required: true, max: 120 },
      { name: "role", type: "select", values: ["viewer", "approver", "finance", "admin"], maxSelect: 1 },
      { name: "dept", type: "text", max: 120 },
      { name: "approverRoles", type: "json", maxSize: 4000 },
      { name: "note", type: "text", max: 300 },
      { name: "xid", type: "text", max: 60 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_req_users_username ON req_users (username)",
      "CREATE UNIQUE INDEX idx_req_users_xid ON req_users (xid)"
    ],
    listRule: AUTHED,
    viewRule: AUTHED,
    createRule: ADMIN_ONLY,
    // A user may update their OWN record (name/note/etc.) but must NEVER be
    // able to change their own role or approverRoles — otherwise any account
    // self-promotes to admin with a single PATCH. The offline-sync client
    // sends the FULL record body on every update, so we can't use :isset here
    // (it's always set); instead the privilege fields are allowed only when
    // their value is UNCHANGED (equals the caller's current value). Any attempt
    // to submit a different role/approverRoles fails this branch and, not being
    // admin, is rejected.
    updateRule: `${ADMIN_ONLY} || (id = @request.auth.id && (@request.body.role:isset = false || @request.body.role = @request.auth.role) && (@request.body.approverRoles:isset = false || @request.body.approverRoles = @request.auth.approverRoles))`,
    deleteRule: ADMIN_ONLY,
    manageRule: ADMIN_ONLY,
    passwordAuth: { enabled: true, identityFields: ["email", "username"] }
  },
  {
    name: "req_vendors",
    type: "base",
    fields: [
      { name: "xid", type: "text", max: 60 },
      { name: "name", type: "text", required: true, max: 200 },
      { name: "category", type: "text", max: 120 },
      { name: "contact", type: "text", max: 120 },
      { name: "phone", type: "text", max: 60 },
      { name: "email", type: "text", max: 150 },
      { name: "address", type: "text", max: 300 },
      { name: "regNo", type: "text", max: 100 },
      { name: "bankName", type: "text", max: 120 },
      { name: "bankAccount", type: "text", max: 120 },
      { name: "accountName", type: "text", max: 150 },
      { name: "status", type: "text", max: 30 },
      { name: "note", type: "text", max: 500 },
      { name: "docs", type: "json", maxSize: 20000 },
      { name: "fileMap", type: "json", maxSize: 20000 },
      // protected: files (GST certs, bank docs) are served only with a valid
      // file-access token, never to anyone who guesses/forwards the raw URL.
      { name: "documents", type: "file", maxSelect: 10, maxSize: 8388608, protected: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_req_vendors_xid ON req_vendors (xid)"],
    // Vendors carry payout bank details — only finance/admin may create, edit,
    // or delete them (a low-priv account rewriting a vendor's bank account is a
    // payment-fraud vector). All staff may still read the register.
    listRule: AUTHED, viewRule: AUTHED, createRule: FINANCE_OR_ADMIN, updateRule: FINANCE_OR_ADMIN, deleteRule: FINANCE_OR_ADMIN
  },
  {
    name: "req_requisitions",
    type: "base",
    fields: [
      { name: "xid", type: "text", max: 60 },
      { name: "number", type: "text", max: 60 },
      { name: "date", type: "text", max: 40 },
      { name: "poNumber", type: "text", max: 60 },
      { name: "type", type: "text", max: 20 },
      { name: "currency", type: "text", max: 10 },
      { name: "budgetLine", type: "text", max: 40 },
      { name: "quoteCriteria", type: "text", max: 20 },
      { name: "gstApplied", type: "bool" },
      { name: "taxType", type: "text", max: 10 }, // none | gst | tgst (replaces gstApplied)
      { name: "grn", type: "json", maxSize: 60000 }, // Goods Received Note {receivedAt, receivedBy, items[], note, fileId}
      { name: "invoiceStatus", type: "text", max: 20 },
      { name: "convertedFromId", type: "text", max: 60 },
      { name: "convertedToId", type: "text", max: 60 },
      { name: "mergedIntoId", type: "text", max: 60 },
      { name: "mergedFromIds", type: "json", maxSize: 20000 },
      { name: "receipts", type: "json", maxSize: 200000 },
      { name: "department", type: "text", max: 120 },
      { name: "project", type: "text", max: 200 },
      { name: "purpose", type: "text", max: 1000 },
      { name: "payee", type: "text", max: 200 },
      { name: "payeeVendorId", type: "text", max: 60 },
      { name: "preparedBy", type: "text", max: 120 },
      { name: "preparedDate", type: "text", max: 40 },
      { name: "items", type: "json", maxSize: 200000 },
      { name: "subTotal", type: "number" },
      { name: "gstAmount", type: "number" },
      { name: "total", type: "number" },
      { name: "quotes", type: "json", maxSize: 200000 },
      { name: "quoteJustification", type: "text", max: 2000 },
      { name: "chain", type: "json", maxSize: 100000 },
      { name: "paymentStatus", type: "text", max: 20 },
      { name: "paidDate", type: "text", max: 40 },
      { name: "paidRef", type: "text", max: 120 },
      { name: "odooStatus", type: "text", max: 20 },
      { name: "odooRef", type: "text", max: 120 },
      { name: "targetDays", type: "number" },
      { name: "createdAtStr", type: "text", max: 40 },
      { name: "completedAt", type: "text", max: 40 },
      { name: "fileMap", type: "json", maxSize: 100000 },
      // protected: quote/invoice files need a file-access token. Authed staff
      // fetch one via pb.files.getToken(); the anonymous approval page gets one
      // minted by the approval-state hook (record.newFileToken()).
      { name: "attachments", type: "file", maxSelect: 30, maxSize: 8388608, protected: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_req_reqs_xid ON req_requisitions (xid)"],
    // Create/update stay open to all staff (the offline diff-sync client pushes
    // each user's own drafts), but the field-level workflow guard in
    // pb_hooks/fam.pb.js blocks non-finance callers from mutating payment/chain
    // fields or forging approvals. Delete is finance/admin-only (matches the UI,
    // where the delete control is gated behind canFinance()).
    listRule: AUTHED, viewRule: AUTHED, createRule: AUTHED, updateRule: AUTHED, deleteRule: FINANCE_OR_ADMIN
  },
  {
    name: "req_approvals",
    type: "base",
    fields: [
      { name: "token", type: "text", required: true, max: 80 },
      { name: "reqXid", type: "text", max: 60 },
      { name: "stepKey", type: "text", max: 40 },
      { name: "status", type: "select", values: ["pending", "approved", "rejected", "hold"], maxSelect: 1 },
      { name: "approverName", type: "text", max: 120 },
      { name: "comment", type: "text", max: 2000 },
      { name: "decidedAt", type: "text", max: 40 },
      { name: "snapshot", type: "json", maxSize: 400000 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_req_approvals_token ON req_approvals (token)"],
    // token-scoped anonymous access: ?t=<token> must match the record
    listRule: `${AUTHED} || token = @request.query.t`,
    viewRule: `${AUTHED} || token = @request.query.t`,
    createRule: AUTHED,
    // anonymous may only flip an OPEN (pending / on-hold) record's decision
    // fields — never the token/req binding, the snapshot, or WHO the link is
    // assigned to (the signer identity is fixed when the link is issued)
    updateRule: `${AUTHED} || (token = @request.query.t && (status = "pending" || status = "hold") && @request.body.token:isset = false && @request.body.reqXid:isset = false && @request.body.stepKey:isset = false && @request.body.snapshot:isset = false && @request.body.approverName:isset = false)`,
    deleteRule: AUTHED
  },
  {
    // Single-record app configuration edited from the Admin tab. Everything that
    // used to be hardcoded in index.html CONFIG lives here (prefix, sequences,
    // tax rates, vendor categories, currencies, departments, approval chain,
    // low-value threshold rule, Odoo connection). key = "main".
    name: "req_settings",
    type: "base",
    fields: [
      { name: "key", type: "text", required: true, max: 40 },
      { name: "data", type: "json", maxSize: 200000 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_req_settings_key ON req_settings (key)"],
    listRule: AUTHED, viewRule: AUTHED,
    createRule: ADMIN_ONLY, updateRule: ADMIN_ONLY, deleteRule: ADMIN_ONLY
  },
  {
    // Audit trail: one row per meaningful change (create, approve/reject step,
    // payment, Odoo post, GRN, revert). Written ONLY by server hooks — clients
    // can read but never create/edit/delete an audit row.
    name: "req_audit",
    type: "base",
    fields: [
      { name: "reqXid", type: "text", max: 60 },
      { name: "reqNumber", type: "text", max: 60 },
      { name: "action", type: "text", max: 60 },
      { name: "actorId", type: "text", max: 60 },
      { name: "actorName", type: "text", max: 120 },
      { name: "detail", type: "json", maxSize: 20000 },
      { name: "at", type: "text", max: 40 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false }
    ],
    indexes: ["CREATE INDEX idx_req_audit_req ON req_audit (reqXid)"],
    listRule: AUTHED, viewRule: AUTHED,
    createRule: null, updateRule: null, deleteRule: null
  }
];

async function upsertCollection(def) {
  let existing = null;
  try { existing = await api("GET", `/api/collections/${def.name}`); } catch (e) { if (e.status !== 404) throw e; }
  if (!existing) {
    await api("POST", "/api/collections", def);
    console.log(`created collection ${def.name}`);
  } else {
    // merge fields: keep existing (incl. system) fields, replace ours with the
    // current definition (so e.g. new select values apply), add any missing
    const ours = new Map(def.fields.map(f => [f.name, f]));
    const merged = (existing.fields || []).map(f => {
      if (!ours.has(f.name)) return f;
      const nf = { ...f, ...ours.get(f.name) };
      ours.delete(f.name);
      return nf;
    });
    for (const f of ours.values()) merged.push(f);
    const patch = {
      fields: merged,
      indexes: Array.from(new Set([...(existing.indexes || []), ...(def.indexes || [])])),
      listRule: def.listRule, viewRule: def.viewRule,
      createRule: def.createRule, updateRule: def.updateRule, deleteRule: def.deleteRule
    };
    if (def.manageRule !== undefined) patch.manageRule = def.manageRule;
    if (def.passwordAuth) patch.passwordAuth = def.passwordAuth;
    await api("PATCH", `/api/collections/${existing.id}`, patch);
    console.log(`updated collection ${def.name} (rules re-applied)`);
  }
  // auth collections: make email optional so username-only accounts work
  if (def.type === "auth") {
    const c = await api("GET", `/api/collections/${def.name}`);
    let touched = false;
    const fields = (c.fields || []).map(f => {
      if (f.name === "email" && f.required) { touched = true; return { ...f, required: false }; }
      return f;
    });
    if (touched) {
      await api("PATCH", `/api/collections/${c.id}`, { fields });
      console.log(`  ${def.name}: email made optional (username sign-in)`);
    }
  }
}

const genPass = () =>
  Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + "!";

const SEED_USERS = [
  { xid: "u_eema",      username: "eema",      name: "Eema",           role: "finance",  dept: "Admin",       approverRoles: [], note: "Prepares requisitions, payments & Odoo" },
  { xid: "u_sajjah",    username: "sajjah",    name: "Mohamed Sajjah", role: "approver", dept: "Competition", approverRoles: ["dept_head"], note: "Department Head" },
  { xid: "u_zareer",    username: "zareer",    name: "Ahmed Zareer",   role: "approver", dept: "Secretariat", approverRoles: ["general_secretary"], note: "General Secretary" },
  { xid: "u_imhaal",    username: "imhaal",    name: "Ismail Imhaal",  role: "approver", dept: "Finance",     approverRoles: ["finance_confirm"], note: "Finance Manager — budget confirmation" },
  { xid: "u_president", username: "president", name: "President",      role: "approver", dept: "Executive",   approverRoles: ["president"], note: "President / S.VP / VP" },
  { xid: "u_ankura",    username: "ankura",    name: "Ankura",         role: "approver", dept: "External",    approverRoles: ["external"], note: "External approval (one-click link)" },
  { xid: "u_admin",     username: "admin",     name: "Admin",          role: "admin",    dept: "IT",          approverRoles: ["dept_head", "general_secretary", "finance_confirm", "president", "external"], note: "System administrator" }
];

const SEED_VENDORS = [
  { xid: "v_donad",   name: "DONAD INVESTMENTS", category: "Awards & Trophies",  contact: "Ahmed Donad",  phone: "+960 777-0011", email: "sales@donad.mv", accountName: "Donad Investments Pvt Ltd", bankName: "BML", bankAccount: "7701-000-1234567" },
  { xid: "v_sgear",   name: "Sports Gear Pvt Ltd", category: "Sports Equipment", contact: "Riyaz",        phone: "+960 779-2244", email: "orders@sportsgear.mv" },
  { xid: "v_mooinc",  name: "Mooinc Creative",   category: "Creative & Media",   contact: "Mooza",        phone: "+960 990-5566", email: "hello@mooinc.mv" },
  { xid: "v_medico",  name: "Medico Supplies",   category: "Medical & Physio",   contact: "Dr. Faisal",   phone: "+960 778-8821", email: "supply@medico.mv" },
  { xid: "v_coolair", name: "CoolAir Maldives",  category: "Facilities & MEP",   contact: "Service Desk", phone: "+960 332-1100", email: "service@coolair.mv" },
  { xid: "v_tworld",  name: "Trophy World",      category: "Awards & Trophies",  contact: "Counter",      phone: "+960 776-3322", email: "info@trophyworld.mv" },
  { xid: "v_iph",     name: "Island Print House", category: "Printing & Signage", contact: "Hassan",      phone: "+960 331-7788", email: "print@iph.mv" }
];

async function seed() {
  const creds = [];
  for (const u of SEED_USERS) {
    let exists = null;
    try {
      const r = await api("GET", `/api/collections/req_users/records?filter=${encodeURIComponent(`username="${u.username}"`)}&perPage=1`);
      exists = r.items && r.items[0];
    } catch { /* treat as missing */ }
    if (exists) { console.log(`user ${u.username} exists — skipped`); continue; }
    const pw = genPass();
    await api("POST", "/api/collections/req_users/records", { ...u, password: pw, passwordConfirm: pw, emailVisibility: false });
    creds.push(`${u.name.padEnd(16)} username: ${u.username.padEnd(12)} password: ${pw}`);
    console.log(`user ${u.username} created`);
  }
  for (const v of SEED_VENDORS) {
    let exists = null;
    try {
      const r = await api("GET", `/api/collections/req_vendors/records?filter=${encodeURIComponent(`xid="${v.xid}"`)}&perPage=1`);
      exists = r.items && r.items[0];
    } catch { /* treat as missing */ }
    if (exists) { console.log(`vendor ${v.name} exists — skipped`); continue; }
    await api("POST", "/api/collections/req_vendors/records", { status: "active", note: "", ...v });
    console.log(`vendor ${v.name} created`);
  }
  if (creds.length) {
    const out = `FAM Requisition System — generated sign-in credentials (${new Date().toISOString()})\nApp: (your app URL)   Backend: ${PB}\n\n${creds.join("\n")}\n\nShare each line with its user. Passwords can be changed by an admin in PocketBase.\n`;
    writeFileSync(new URL("../fam-req-credentials.txt", import.meta.url), out);
    console.log("\n" + out);
    console.log("Written to fam-req-credentials.txt (git-ignored). Store it somewhere safe, then delete it.");
  }
}

// Default app settings — everything the Admin tab can change. Seeded once
// (key "main"); never overwritten on re-run so admin edits survive.
const YEAR = new Date().getFullYear();
const DEFAULT_SETTINGS = {
  reqPrefix: "FAM/REQ",
  // server-assigned requisition numbers: FAM/REQ/<year>/<next>
  sequences: {
    purchase: { year: YEAR, next: 1 },
    reimbursable: { year: YEAR, next: 1 },
    credit: { year: YEAR, next: 1 }
  },
  taxRates: { gst: 8, tgst: 17 },          // percent
  quotesRequired: 3,                        // for purchase requisitions
  threshold: { enabled: false, amount: 5000, quotesRequired: 1, steps: ["dept_head", "budget"] },
  // approval chain, in order. Budget (finance) now signs BEFORE the General
  // Secretary. The external (Ankura) step is disabled by default and can be
  // deleted entirely from the Admin tab.
  chain: [
    { key: "dept_head", label: "Request Approved By", sublabel: "Department Head", approverRole: "dept_head", enabled: true },
    { key: "budget", label: "Budget Confirmed", sublabel: "Finance Manager / Accounts", approverRole: "finance_confirm", enabled: true },
    { key: "gen_sec", label: "Approved By", sublabel: "General Secretary", approverRole: "general_secretary", enabled: true },
    { key: "authorise", label: "Authorised By", sublabel: "President / S.VP / VP", approverRole: "president", enabled: true },
    { key: "external", label: "External Approval", sublabel: "Ankura", approverRole: "external", enabled: false }
  ],
  vendorCategories: [
    "Awards & Trophies", "Sports Equipment", "Printing & Signage", "Creative & Media",
    "IT & Electronics", "Catering & F&B", "Facilities & MEP", "Travel & Logistics",
    "Medical & Physio", "Construction & Fit-out", "General Supplies", "Other"
  ],
  currencies: ["MVR", "USD", "CHF"],
  departments: [
    "Admin", "Competition", "Technical", "Finance", "Marketing",
    "Operations", "Futsal", "Women's Football", "Referees", "Media", "National Teams"
  ],
  // Odoo connection (API key is NOT stored here — it lives in the ODOO_API_KEY
  // env var on the PocketBase container).
  odoo: { url: "", db: "", username: "", taxIdGst: null, taxIdTgst: null, journalId: null },
  signature: { allowPhysical: true }
};
async function seedSettings() {
  try {
    const r = await api("GET", `/api/collections/req_settings/records?filter=${encodeURIComponent('key="main"')}`);
    if (r.items && r.items.length) { console.log("settings exist, keeping admin edits"); return; }
  } catch { /* fall through */ }
  await api("POST", "/api/collections/req_settings/records", { key: "main", data: DEFAULT_SETTINGS });
  console.log("seeded default settings (req_settings/main)");
}

await login();
for (const def of COLLECTIONS) await upsertCollection(def);
await seedSettings();
if (DO_SEED) await seed();
console.log("Done.");
