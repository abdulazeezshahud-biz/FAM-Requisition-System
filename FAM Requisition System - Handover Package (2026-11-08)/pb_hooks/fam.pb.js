/// <reference path="../pb_data/types.d.ts" />
//
// FAM Requisition System - server-side glue + the workflow authorization guard.
//
//   1. GET  /api/fam/approval-state   public token-scoped LIVE chain state
//   2. POST /api/fam/parse-quote      AI quote extraction (auth + rate-limited)
//   3. onRecordCreateRequest(req_requisitions)  block a non-finance caller from
//        birthing a pre-approved / already-"paid" requisition
//   4. onRecordUpdateRequest(req_requisitions)  block a non-finance caller from
//        mutating payment fields, and only let a chain step flip to a decision
//        that is backed by a real approval record (no forging approvals)
//   5. onRecordCreateRequest(req_approvals)  a non-finance caller may only
//        create PENDING approval links (can't birth an "approved" one)
//   6. onRecordUpdateRequest(req_approvals)  an AUTHENTICATED decision requires
//        finance/admin OR that the caller actually holds the step's approver
//        role; the anonymous magic-link path (no auth, token-scoped by rule)
//        is left to the collection rule
//   7. onRecordAfterUpdateSuccess(req_approvals)  copy a magic-link decision
//        into the requisition chain, RE-READ inside a transaction so two
//        near-simultaneous decisions can't clobber each other's step
//   8. onRecordAfterUpdateSuccess(req_requisitions)  refresh snapshots on the
//        pending approval links
//
// WHY the guard lives here and not only in collection rules: the app is an
// offline diff-sync client, so every logged-in browser legitimately POSTs
// create/update for its own drafts. Locking the collection updateRule by role
// would wedge normal users' sync. Field-level, role-aware enforcement needs
// real logic, so it lives in these request hooks. The hooks' own $app.save /
// txApp.save writes are programmatic (not request hooks), so they are NOT
// re-checked here — only genuine API requests are.
//
// PocketBase runs each handler in an ISOLATED scope, so helpers are inlined
// per handler. JSON fields are read with getString() + JSON.parse.

// Resolve the caller's app role from a request event. Returns one of
// "admin" | "finance" | "<other>" | "" and a `privileged` flag that also
// covers superuser / system (no req_users auth) contexts. Fails CLOSED:
// anything it can't classify as finance/admin/superuser is non-privileged.
function famCallerRole(e) {
  var role = "", sup = false;
  try {
    if (e.auth) {
      var cn = e.auth.collection().name;
      if (cn === "_superusers") sup = true;
      else if (cn === "req_users") role = e.auth.getString("role");
    } else {
      // No auth record on the request. A req_users collectionName rule already
      // gates who reaches a create/update; reaching here with no auth means a
      // superuser/system context (admin UI, provisioning).
      sup = true;
    }
  } catch (x) { role = ""; }
  return { role: role, privileged: sup || role === "finance" || role === "admin", superuser: sup };
}

routerAdd("GET", "/api/fam/approval-state", (e) => {
  const readJSON = (rec, field, dflt) => {
    try { const s = rec.getString(field); if (s) { const v = JSON.parse(s); if (v !== null) return v; } } catch (x) {}
    return dflt;
  };
  const t = e.request.url.query().get("t");
  if (!t) {
    return e.json(404, { error: "not found" });
  }
  let a = null;
  try {
    a = $app.findFirstRecordByFilter("req_approvals", "token = {:t}", { t: t });
  } catch (x) {
    return e.json(404, { error: "not found" });
  }
  const snap = readJSON(a, "snapshot", {});
  // overlay the LIVE chain state from the requisition (strip step tokens)
  try {
    const r = $app.findFirstRecordByFilter("req_requisitions", "xid = {:x}", { x: a.getString("reqXid") });
    const chain = readJSON(r, "chain", []);
    if (chain && chain.length) {
      snap.chain = chain.map((s) => ({
        key: s.key, label: s.label, sublabel: s.sublabel, approverRole: s.approverRole,
        status: s.status, approverName: s.approverName || "", comment: s.comment || "",
        decidedAt: s.decidedAt || null
      }));
    }
  } catch (x) { /* requisition gone - snapshot still renders */ }
  return e.json(200, {
    pbId: a.id,
    token: a.getString("token"),
    status: a.getString("status") || "pending",
    approverName: a.getString("approverName"),
    comment: a.getString("comment"),
    decidedAt: a.getString("decidedAt"),
    snapshot: snap
  });
});

// Serve a PROTECTED requisition attachment to a valid anonymous approval-link
// holder. The link token is the credential; access is SCOPED — the requested
// filename must belong to the exact requisition the token maps to, so a token
// holder can never read another requisition's (or a vendor's) files, and the
// path can't be traversed. Authenticated staff never use this route (they get
// a real file token via pb.files.getToken()).
routerAdd("GET", "/api/fam/approval-file", (e) => {
  const q = e.request.url.query();
  const t = q.get("t");
  const f = q.get("f");
  if (!t || !f) return e.json(404, { error: "not found" });
  let a = null;
  try { a = $app.findFirstRecordByFilter("req_approvals", "token = {:t}", { t: t }); } catch (x) { return e.json(404, { error: "not found" }); }
  if (!a) return e.json(404, { error: "not found" });
  let r = null;
  try { r = $app.findFirstRecordByFilter("req_requisitions", "xid = {:x}", { x: a.getString("reqXid") }); } catch (x) { return e.json(404, { error: "not found" }); }
  if (!r) return e.json(404, { error: "not found" });
  let atts = [];
  try { atts = r.getStringSlice("attachments"); } catch (x) { atts = []; }
  if (atts.indexOf(f) < 0) return e.json(404, { error: "not found" });
  const fsys = $app.newFilesystem();
  const fileKey = r.baseFilesPath() + "/" + f;
  let reader = null;
  try {
    if (!fsys.exists(fileKey)) return e.json(404, { error: "not found" });
    reader = fsys.getReader(fileKey);
    const data = toBytes(reader);
    const lower = f.toLowerCase();
    let ct = "application/octet-stream";
    if (lower.endsWith(".pdf")) ct = "application/pdf";
    else if (lower.endsWith(".png")) ct = "image/png";
    else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) ct = "image/jpeg";
    else if (lower.endsWith(".webp")) ct = "image/webp";
    else if (lower.endsWith(".gif")) ct = "image/gif";
    return e.blob(200, ct, data);
  } catch (x) {
    return e.json(404, { error: "not found" });
  } finally {
    try { if (reader) reader.close(); } catch (y) {}
    try { fsys.close(); } catch (y) {}
  }
});

// AI quote extraction: the app uploads a quotation document (PDF/image) and
// gets back {vendorName, amount, currency, deliveryDays, note}. The Anthropic
// API key lives ONLY here (ANTHROPIC_API_KEY env var on the PB container) -
// it never reaches the browser. Model override: FAM_AI_MODEL env var.
routerAdd("POST", "/api/fam/parse-quote", (e) => {
  // --- rate limit: max 6 scans / user / minute + 60 / user / hour ---
  // App-level store persists across request scopes (unlike per-handler vars).
  try {
    var uid = (e.auth && e.auth.id) ? e.auth.id : "anon";
    var store = $app.store();
    var minKey = "pq_m_" + uid + "_" + Math.floor(Date.now() / 60000);
    var hrKey = "pq_h_" + uid + "_" + Math.floor(Date.now() / 3600000);
    var m = (store.get(minKey) || 0) + 1;
    var h = (store.get(hrKey) || 0) + 1;
    store.set(minKey, m);
    store.set(hrKey, h);
    if (m > 6 || h > 60) {
      return e.json(429, { error: "rate_limited", message: "Too many quote scans - wait a moment and try again." });
    }
  } catch (x) { /* store unavailable -> don't block the feature */ }

  const key = $os.getenv("ANTHROPIC_API_KEY");
  if (!key) {
    return e.json(503, { error: "ai_not_configured" });
  }
  const info = e.requestInfo();
  const b = info.body || {};
  const name = ("" + (b.name || "quotation")).slice(0, 200);
  const ftype = "" + (b.type || "");
  const data = "" + (b.data || "");
  if (!data || data.length > 11500000) {
    return e.json(400, { error: "file missing or too large (max ~8 MB)" });
  }
  let docBlock;
  if (ftype === "application/pdf") {
    docBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: data } };
  } else if (ftype === "image/png" || ftype === "image/jpeg" || ftype === "image/webp" || ftype === "image/gif") {
    docBlock = { type: "image", source: { type: "base64", media_type: ftype, data: data } };
  } else {
    return e.json(415, { error: "unsupported file type - upload a PDF or an image" });
  }
  const model = $os.getenv("FAM_AI_MODEL") || "claude-opus-4-8";
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["vendorName", "amount", "currency", "deliveryDays", "note"],
    properties: {
      vendorName: { type: "string", description: "Company/supplier name issuing this quotation. Empty string if not identifiable." },
      amount: { type: "number", description: "The grand total quoted, including taxes/GST if shown. 0 if no total is found." },
      currency: { type: "string", description: "3-letter currency code of the total (MVR, USD, CHF, ...). Empty string if unclear." },
      deliveryDays: { type: "integer", description: "Promised delivery / lead time converted to days (e.g. '2 weeks' -> 14). 0 if not stated." },
      note: { type: "string", description: "One short line worth recording next to the quote: payment terms, validity period, or key exclusions. Empty string if none." }
    }
  };
  const payload = {
    model: model,
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: schema } },
    messages: [{
      role: "user",
      content: [
        docBlock,
        { type: "text", text: "This file (" + name + ") is a supplier quotation received by the Football Association of Maldives procurement team. Extract the requested fields exactly as they appear in the document. Use the grand total (after taxes/GST) as the amount. If several items are quoted, still use the single grand total." }
      ]
    }]
  };
  try {
    const res = $http.send({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 120
    });
    let rj = null;
    try { rj = res.json; } catch (x) {}
    if (!rj) { try { rj = JSON.parse(toString(res.body)); } catch (x) {} }
    if (res.statusCode !== 200 || !rj) {
      console.log("[fam.pb.js] parse-quote upstream error:", res.statusCode);
      return e.json(502, { error: "ai_error" });
    }
    let text = "";
    const content = rj.content || [];
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === "text") text += content[i].text;
    }
    const out = JSON.parse(text);
    return e.json(200, out);
  } catch (err) {
    console.log("[fam.pb.js] parse-quote failed:", err);
    return e.json(502, { error: "ai_error" });
  }
}, $apis.requireAuth("req_users"));

// ---- R2 guard: a non-finance caller cannot CREATE a pre-approved/paid req ----
onRecordCreateRequest((e) => {
  var role = "", sup = false;
  try {
    if (e.auth) {
      var cn = e.auth.collection().name;
      if (cn === "_superusers") sup = true;
      else if (cn === "req_users") role = e.auth.getString("role");
    } else { sup = true; }
  } catch (x) { role = ""; }
  if (!(sup || role === "finance" || role === "admin")) {
    var rec = e.record;
    if (rec.getString("paymentStatus") === "paid") throw new BadRequestError("A new requisition cannot start marked paid.");
    if (rec.getString("paidRef")) throw new BadRequestError("A new requisition cannot start with a payment reference.");
    if (rec.getString("odooStatus") === "posted") throw new BadRequestError("A new requisition cannot start posted.");
    var chain = [];
    try { var cs = rec.getString("chain"); if (cs) chain = JSON.parse(cs) || []; } catch (x) { chain = []; }
    for (var i = 0; i < chain.length; i++) {
      var stt = chain[i] && chain[i].status;
      if (stt && stt !== "pending") throw new BadRequestError("A new requisition must start with every approval step pending.");
    }
  }

  // ---- SERVER-ASSIGNED requisition number (atomic) ----
  // The browser used to compute "max+1" locally, so two people saving at the
  // same time could get the SAME number. Now the server reserves the next
  // number from req_settings.sequences inside a transaction. Admin sets the
  // next number from the Admin tab. Safety: never go below the highest number
  // already used for this prefix/year.
  var rec2 = e.record;
  try {
    var type = rec2.getString("type") || "purchase";
    var seqKey = type === "reimbursable" ? "reimbursable" : type === "credit" ? "credit" : "purchase";
    var year = new Date().getFullYear();
    $app.runInTransaction(function (txApp) {
      var s = null, data = {};
      try { s = txApp.findFirstRecordByFilter("req_settings", "key = 'main'"); data = JSON.parse(s.getString("data") || "{}") || {}; } catch (x) { s = null; data = {}; }
      var base = data.reqPrefix || "FAM/REQ";
      var prefix = seqKey === "reimbursable" ? base.replace(/REQ$/, "EXP") : seqKey === "credit" ? base.replace(/REQ$/, "CSR") : base;
      data.sequences = data.sequences || {};
      var seq = data.sequences[seqKey] || { year: year, next: 1 };
      if (seq.year !== year) seq = { year: year, next: 1 };
      var max = 0;
      try {
        var existing = txApp.findRecordsByFilter("req_requisitions", "number ~ {:p}", "", 0, 0, { p: prefix + "/" + year + "/" });
        for (var k = 0; k < existing.length; k++) { var m = /\/(\d+)$/.exec(existing[k].getString("number")); if (m) max = Math.max(max, parseInt(m[1], 10)); }
      } catch (x) {}
      var n = Math.max(seq.next || 1, max + 1);
      rec2.set("number", prefix + "/" + year + "/" + String(n).padStart(3, "0"));
      seq.next = n + 1; data.sequences[seqKey] = seq;
      if (s) { s.set("data", data); txApp.save(s); }
    });
  } catch (err) { console.log("[fam.pb.js] numbering failed, keeping client number:", err); }

  e.next();

  // ---- audit: created ----
  try {
    var col = $app.findCollectionByNameOrId("req_audit");
    var ar = new Record(col);
    ar.set("reqXid", rec2.getString("xid")); ar.set("reqNumber", rec2.getString("number")); ar.set("action", "created");
    ar.set("actorId", e.auth ? e.auth.id : ""); ar.set("actorName", e.auth ? e.auth.getString("name") : "system");
    ar.set("detail", { type: rec2.getString("type"), total: rec2.getFloat("total"), currency: rec2.getString("currency") });
    ar.set("at", new Date().toISOString());
    $app.save(ar);
  } catch (x) { console.log("[fam.pb.js] audit(create) failed:", x); }
}, "req_requisitions");

// ---- R2 guard: a non-finance caller cannot change payment fields or forge a
// chain decision. A chain step may only flip to approved/rejected/hold if a
// real req_approvals record for that step already carries that status. ----
onRecordUpdateRequest((e) => {
  var role = "", sup = false;
  try {
    if (e.auth) {
      var cn = e.auth.collection().name;
      if (cn === "_superusers") sup = true;
      else if (cn === "req_users") role = e.auth.getString("role");
    } else { sup = true; }
  } catch (x) { role = ""; }
  var rec = e.record, orig = rec.original();
  var parse = function (r) { try { var s = r.getString("chain"); return s ? (JSON.parse(s) || []) : []; } catch (x) { return []; } };
  var nc = parse(rec), oc = parse(orig);

  // ---- capture what changed (audit trail, every caller) ----
  var changes = {};
  var watch = ["paymentStatus", "paidRef", "paidDate", "odooStatus", "odooRef", "grn", "total", "payee", "budgetLine", "taxType", "number"];
  for (var w = 0; w < watch.length; w++) {
    var fa = orig.getString(watch[w]), fb = rec.getString(watch[w]);
    if (fa !== fb) changes[watch[w]] = { from: fa.slice(0, 300), to: fb.slice(0, 300) };
  }
  var stepChanges = [];
  for (var j = 0; j < nc.length; j++) {
    var ns = (nc[j] && nc[j].status) || "", os2 = (oc[j] && oc[j].status) || "";
    if (ns !== os2) stepChanges.push({ step: nc[j] && nc[j].key, label: nc[j] && nc[j].sublabel, from: os2, to: ns, by: (nc[j] && nc[j].approverName) || "", signMode: (nc[j] && nc[j].signMode) || "electronic" });
  }
  if (stepChanges.length) changes.chain = stepChanges;

  // The server owns the requisition number. A client (e.g. an older cached
  // build that still computes its own) may echo a stale value on re-sync —
  // keep the server's value rather than rejecting the whole update.
  if (!(sup || role === "finance" || role === "admin") && rec.getString("number") !== orig.getString("number")) {
    rec.set("number", orig.getString("number")); delete changes.number;
  }
  if (!(sup || role === "finance" || role === "admin")) {
    var locked = ["paymentStatus", "paidDate", "paidRef", "odooStatus", "odooRef"];
    for (var i = 0; i < locked.length; i++) {
      if (rec.getString(locked[i]) !== orig.getString(locked[i])) {
        throw new BadRequestError("Only finance can change payment, posting or numbering fields.");
      }
    }
    for (var j2 = 0; j2 < nc.length; j2++) {
      var ns2 = (nc[j2] && nc[j2].status) || "", os3 = (oc[j2] && oc[j2].status) || "";
      if (ns2 !== os3 && (ns2 === "approved" || ns2 === "rejected" || ns2 === "hold")) {
        var ok = false;
        try {
          var ap = $app.findFirstRecordByFilter(
            "req_approvals", "reqXid = {:x} && stepKey = {:k}",
            { x: rec.getString("xid"), k: (nc[j2] && nc[j2].key) || "" }
          );
          if (ap && ap.getString("status") === ns2) ok = true;
        } catch (x) { ok = false; }
        if (!ok) throw new BadRequestError("That approval decision is not authorized.");
      }
    }
  }
  e.next();

  // ---- audit: record meaningful changes ----
  if (Object.keys(changes).length) {
    try {
      var action = "edited";
      if (changes.paymentStatus && changes.paymentStatus.to === "paid") action = "payment.paid";
      else if (changes.paymentStatus) action = "payment.changed";
      else if (changes.odooStatus && changes.odooStatus.to === "posted") action = "odoo.posted";
      else if (changes.odooStatus) action = "odoo.unposted";
      else if (changes.grn) action = "grn.recorded";
      else if (changes.chain) { var last = stepChanges[stepChanges.length - 1]; action = "step." + (last.to || "changed") + (last.signMode === "physical" ? ".physical" : ""); }
      else if (changes.number) action = "renumbered";
      var col = $app.findCollectionByNameOrId("req_audit");
      var ar = new Record(col);
      ar.set("reqXid", rec.getString("xid")); ar.set("reqNumber", rec.getString("number")); ar.set("action", action);
      ar.set("actorId", e.auth ? e.auth.id : ""); ar.set("actorName", e.auth ? e.auth.getString("name") : "system");
      ar.set("detail", changes); ar.set("at", new Date().toISOString());
      $app.save(ar);
    } catch (x) { console.log("[fam.pb.js] audit(update) failed:", x); }
  }
}, "req_requisitions");

// ---- R2 backstop: a non-finance caller may only CREATE a PENDING approval
// link (the diff-sync client legitimately creates the chain's pending links);
// it can't fabricate an already-"approved" record to satisfy the chain guard. -
onRecordCreateRequest((e) => {
  var role = "", sup = false;
  try {
    if (e.auth) {
      var cn = e.auth.collection().name;
      if (cn === "_superusers") sup = true;
      else if (cn === "req_users") role = e.auth.getString("role");
    } else { sup = true; }
  } catch (x) { role = ""; }
  if (!(sup || role === "finance" || role === "admin")) {
    var st = e.record.getString("status");
    if (st && st !== "pending") throw new BadRequestError("A new approval link must start pending.");
  }
  e.next();
}, "req_approvals");

// ---- R2 backstop: an AUTHENTICATED approval decision requires finance/admin
// OR that the caller actually holds the step's approver role. The anonymous
// magic-link path has no auth record (rule-gated by ?t=token) and is allowed. -
onRecordUpdateRequest((e) => {
  // anonymous (magic-link) update: no auth -> authorized by the collection rule
  if (!e.auth) { e.next(); return; }
  var role = "", sup = false;
  try {
    var cn = e.auth.collection().name;
    if (cn === "_superusers") sup = true;
    else if (cn === "req_users") role = e.auth.getString("role");
  } catch (x) { role = ""; }
  if (!(sup || role === "finance" || role === "admin")) {
    var rec = e.record, orig = rec.original();
    var ns = rec.getString("status"), os2 = orig.getString("status");
    if (ns !== os2 && (ns === "approved" || ns === "rejected" || ns === "hold")) {
      // does this caller hold the approver role this step requires?
      var stepRole = "";
      var mine = [];
      try { var mr = e.auth.getString("approverRoles"); if (mr) mine = JSON.parse(mr) || []; } catch (x) { mine = []; }
      // find the step in the requisition chain to learn its approverRole
      try {
        var r = $app.findFirstRecordByFilter("req_requisitions", "xid = {:x}", { x: rec.getString("reqXid") });
        var chain = []; try { var cs = r.getString("chain"); if (cs) chain = JSON.parse(cs) || []; } catch (y) {}
        for (var i = 0; i < chain.length; i++) { if (chain[i] && chain[i].key === rec.getString("stepKey")) { stepRole = chain[i].approverRole || ""; break; } }
      } catch (x) { stepRole = ""; }
      if (!stepRole || mine.indexOf(stepRole) < 0) {
        throw new BadRequestError("You are not an authorized approver for this step.");
      }
    }
  }
  e.next();
}, "req_approvals");

// approval decided via magic link -> write it into the requisition chain.
// R8: re-read the requisition INSIDE a transaction so two near-simultaneous
// decisions on different steps can't clobber each other (the previous version
// read the chain outside any transaction, so the second save overwrote the
// first step's update).
onRecordAfterUpdateSuccess((e) => {
  const readJSON = (rec, field, dflt) => {
    try { const s = rec.getString(field); if (s) { const v = JSON.parse(s); if (v !== null) return v; } } catch (x) {}
    return dflt;
  };
  try {
    const a = e.record;
    const status = a.getString("status");
    if (status === "approved" || status === "rejected" || status === "hold") {
      const reqXid = a.getString("reqXid");
      const stepKey = a.getString("stepKey");
      const approverName = a.getString("approverName");
      const comment = a.getString("comment");
      const decidedAt = a.getString("decidedAt");
      $app.runInTransaction((txApp) => {
        const r = txApp.findFirstRecordByFilter("req_requisitions", "xid = {:x}", { x: reqXid });
        const chain = readJSON(r, "chain", []);
        let changed = false;
        for (let i = 0; i < chain.length; i++) {
          const s = chain[i];
          // open steps (pending or on-hold) take the link decision; final in-app
          // decisions (approved/rejected) are never overwritten
          if (s.key === stepKey && (s.status === "pending" || s.status === "hold") && s.status !== status) {
            s.status = status;
            s.approverName = a.getString("approverName") || s.approverName || s.sublabel || "Approver";
            s.decidedAt = decidedAt || new Date().toISOString();
            if (comment) s.comment = comment;
            changed = true;
          }
        }
        if (changed) {
          r.set("chain", chain);
          txApp.save(r);
          // audit: decision made through the personal magic link
          try {
            const col = txApp.findCollectionByNameOrId("req_audit");
            const ar = new Record(col);
            ar.set("reqXid", reqXid); ar.set("reqNumber", r.getString("number")); ar.set("action", "step." + status + ".link");
            ar.set("actorId", ""); ar.set("actorName", approverName || "approver (via link)");
            ar.set("detail", { step: stepKey, to: status, comment: comment || "", signMode: "electronic" });
            ar.set("at", new Date().toISOString());
            txApp.save(ar);
          } catch (x) {}
        }
      });
    }
  } catch (err) {
    console.log("[fam.pb.js] approval->chain sync failed:", err);
  }
  e.next();
}, "req_approvals");

// requisition changed -> refresh snapshots on its pending approval links
onRecordAfterUpdateSuccess((e) => {
  const readJSON = (rec, field, dflt) => {
    try { const s = rec.getString(field); if (s) { const v = JSON.parse(s); if (v !== null) return v; } } catch (x) {}
    return dflt;
  };
  try {
    const r = e.record;
    const chain = readJSON(r, "chain", []);
    const liteChain = chain.map((s) => ({
      key: s.key, label: s.label, sublabel: s.sublabel, approverRole: s.approverRole,
      status: s.status, approverName: s.approverName || "", comment: s.comment || "",
      decidedAt: s.decidedAt || null
    }));
    const apps = $app.findRecordsByFilter("req_approvals", "reqXid = {:x} && status = 'pending'", "", 0, 0, { x: r.getString("xid") });
    for (let i = 0; i < apps.length; i++) {
      const a = apps[i];
      const snap = readJSON(a, "snapshot", {});
      snap.chain = liteChain;
      a.set("snapshot", snap);
      $app.save(a);
    }
  } catch (err) { /* no pending approvals - fine */ }
  e.next();
}, "req_requisitions");

// ---- LOGIN RATE-LIMIT: PocketBase has none by default, so a password could be
// brute-forced indefinitely. Cap attempts per identity+IP per 10-minute window.
onRecordAuthWithPasswordRequest((e) => {
  try {
    const store = $app.store();
    let ident = ""; try { ident = ("" + (e.identity || "")).toLowerCase(); } catch (x) {}
    let ip = ""; try { ip = e.realIP(); } catch (x) {}
    const bucket = "auth_" + ident + "_" + ip + "_" + Math.floor(Date.now() / 600000);
    const n = (store.get(bucket) || 0) + 1;
    store.set(bucket, n);
    if (n > 12) throw new BadRequestError("Too many sign-in attempts. Please wait 10 minutes and try again.");
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
  }
  e.next();
}, "req_users");

// ---- ODOO: test connection (admin/finance) ----
// Odoo JSON-RPC. The API key lives ONLY in the ODOO_API_KEY env var on this
// container; url/db/username come from req_settings.odoo (edited in Admin).
routerAdd("POST", "/api/fam/odoo-test", (e) => {
  const rpc = (url, service, method, args) => {
    const res = $http.send({ url: url.replace(/\/+$/, "") + "/jsonrpc", method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: { service: service, method: method, args: args } }), timeout: 60 });
    let j = null; try { j = res.json; } catch (x) {} if (!j) { try { j = JSON.parse(toString(res.body)); } catch (x) {} }
    if (!j) throw new Error("Odoo returned HTTP " + res.statusCode);
    if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message || "Odoo error");
    return j.result;
  };
  let role = ""; try { role = e.auth.getString("role"); } catch (x) {}
  if (role !== "admin" && role !== "finance") return e.json(403, { error: "forbidden" });
  const key = $os.getenv("ODOO_API_KEY");
  if (!key) return e.json(503, { error: "odoo_key_missing", message: "ODOO_API_KEY is not set on the server." });
  let cfg = {};
  try { const s = $app.findFirstRecordByFilter("req_settings", "key = 'main'"); cfg = (JSON.parse(s.getString("data") || "{}") || {}).odoo || {}; } catch (x) {}
  if (!cfg.url || !cfg.db || !cfg.username) return e.json(400, { error: "odoo_not_configured", message: "Set Odoo URL, database and username in Admin → Odoo." });
  try {
    const uid = rpc(cfg.url, "common", "authenticate", [cfg.db, cfg.username, key, {}]);
    if (!uid) return e.json(401, { error: "odoo_auth_failed", message: "Odoo rejected the username / API key." });
    let version = ""; try { const v = rpc(cfg.url, "common", "version", []); version = v && v.server_version; } catch (x) {}
    return e.json(200, { ok: true, uid: uid, version: version });
  } catch (err) { return e.json(502, { error: "odoo_error", message: "" + (err && err.message || err) }); }
}, $apis.requireAuth("req_users"));

// ---- ODOO: post a requisition as a VENDOR BILL (account.move in_invoice) ----
routerAdd("POST", "/api/fam/odoo-post", (e) => {
  const rpc = (url, service, method, args) => {
    const res = $http.send({ url: url.replace(/\/+$/, "") + "/jsonrpc", method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: { service: service, method: method, args: args } }), timeout: 90 });
    let j = null; try { j = res.json; } catch (x) {} if (!j) { try { j = JSON.parse(toString(res.body)); } catch (x) {} }
    if (!j) throw new Error("Odoo returned HTTP " + res.statusCode);
    if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message || "Odoo error");
    return j.result;
  };
  const readJSON = (rec, field, dflt) => { try { const s = rec.getString(field); if (s) { const v = JSON.parse(s); if (v !== null) return v; } } catch (x) {} return dflt; };
  let role = ""; try { role = e.auth.getString("role"); } catch (x) {}
  if (role !== "admin" && role !== "finance") return e.json(403, { error: "forbidden" });
  const body = (e.requestInfo().body) || {};
  const reqXid = "" + (body.reqXid || "");
  if (!reqXid) return e.json(400, { error: "reqXid required" });
  let r = null; try { r = $app.findFirstRecordByFilter("req_requisitions", "xid = {:x}", { x: reqXid }); } catch (x) {}
  if (!r) return e.json(404, { error: "requisition not found" });
  if (r.getString("odooStatus") === "posted") return e.json(400, { error: "already_posted", message: "Already posted: " + r.getString("odooRef") });
  const key = $os.getenv("ODOO_API_KEY");
  if (!key) return e.json(503, { error: "odoo_key_missing", message: "ODOO_API_KEY is not set on the server." });
  let cfg = {};
  try { const s = $app.findFirstRecordByFilter("req_settings", "key = 'main'"); cfg = (JSON.parse(s.getString("data") || "{}") || {}).odoo || {}; } catch (x) {}
  if (!cfg.url || !cfg.db || !cfg.username) return e.json(400, { error: "odoo_not_configured", message: "Set Odoo URL, database and username in Admin → Odoo." });
  try {
    const url = cfg.url, db = cfg.db;
    const uid = rpc(url, "common", "authenticate", [db, cfg.username, key, {}]);
    if (!uid) return e.json(401, { error: "odoo_auth_failed", message: "Odoo rejected the username / API key." });
    const ex = (model, method, args, kwargs) => rpc(url, "object", "execute_kw", [db, uid, key, model, method, args, kwargs || {}]);

    // vendor -> res.partner (find by name, else create as a supplier)
    const vendorName = (r.getString("payee") || "Unknown vendor").slice(0, 200);
    let partnerId = null;
    const found = ex("res.partner", "search_read", [[["name", "=", vendorName]]], { fields: ["id"], limit: 1 });
    if (found && found.length) partnerId = found[0].id;
    else partnerId = ex("res.partner", "create", [{ name: vendorName, supplier_rank: 1 }]);

    // lines
    const items = readJSON(r, "items", []);
    const taxType = r.getString("taxType") || (r.getBool("gstApplied") ? "gst" : "none");
    const taxId = taxType === "gst" ? cfg.taxIdGst : taxType === "tgst" ? cfg.taxIdTgst : null;
    const lines = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const line = { name: ("" + (it.item || "Item")).slice(0, 500), quantity: Number(it.qty) || 1, price_unit: Number(it.rate) || 0 };
      if (taxId) line.tax_ids = [[6, 0, [Number(taxId)]]];
      lines.push([0, 0, line]);
    }
    // no Odoo tax record configured -> add the tax as its own line so the total matches
    const taxAmt = r.getFloat("gstAmount") || 0;
    if (!taxId && taxAmt > 0) lines.push([0, 0, { name: taxType === "tgst" ? "TGST" : "GST", quantity: 1, price_unit: taxAmt }]);

    const vals = { move_type: "in_invoice", partner_id: partnerId, invoice_date: new Date().toISOString().slice(0, 10),
      ref: r.getString("number"), narration: (r.getString("purpose") || "").slice(0, 1000), invoice_line_ids: lines };
    if (cfg.journalId) vals.journal_id = Number(cfg.journalId);
    // currency (only if it differs from the default; failure here is non-fatal)
    try {
      const cur = r.getString("currency");
      if (cur) { const c = ex("res.currency", "search_read", [[["name", "=", cur]]], { fields: ["id"], limit: 1 }); if (c && c.length) vals.currency_id = c[0].id; }
    } catch (x) {}

    const moveId = ex("account.move", "create", [vals]);
    let ref = "ID " + moveId;
    try { const mv = ex("account.move", "read", [[moveId]], { fields: ["name"] }); if (mv && mv[0] && mv[0].name && mv[0].name !== "/") ref = mv[0].name; } catch (x) {}

    r.set("odooStatus", "posted"); r.set("odooRef", ref);
    $app.save(r);
    try {
      const col = $app.findCollectionByNameOrId("req_audit"); const ar = new Record(col);
      ar.set("reqXid", reqXid); ar.set("reqNumber", r.getString("number")); ar.set("action", "odoo.posted");
      ar.set("actorId", e.auth.id); ar.set("actorName", e.auth.getString("name"));
      ar.set("detail", { odooRef: ref, moveId: moveId, partnerId: partnerId, lines: lines.length }); ar.set("at", new Date().toISOString());
      $app.save(ar);
    } catch (x) {}
    return e.json(200, { ok: true, odooRef: ref, moveId: moveId });
  } catch (err) {
    console.log("[fam.pb.js] odoo-post failed:", err);
    return e.json(502, { error: "odoo_error", message: "" + (err && err.message || err) });
  }
}, $apis.requireAuth("req_users"));
