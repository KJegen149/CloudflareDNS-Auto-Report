/**
 * Admin UI handler — served at /admin (and /admin/*).
 *
 * Protected by HTTP Basic Auth (env.ADMIN_PASSWORD secret).
 * All state lives in D1 (env.DB). Token encryption via crypto.js.
 *
 * Routes (GET = page, POST = mutation via hidden _method field):
 *   GET  /admin                     → dashboard
 *   GET  /admin/credentials         → list credentials
 *   GET  /admin/credentials/new     → add form
 *   POST /admin/credentials         → create
 *   GET  /admin/credentials/:id/edit → edit form
 *   POST /admin/credentials/:id     → update (_method=PUT) / delete (_method=DELETE)
 *   GET  /admin/reports             → list report configs
 *   GET  /admin/reports/new         → add form
 *   POST /admin/reports             → create
 *   GET  /admin/reports/:id/edit    → edit form
 *   POST /admin/reports/:id         → update (_method=PUT) / pause/resume / delete (_method=DELETE)
 *   GET  /admin/history             → last 100 report runs
 */

import { encryptToken } from './lib/crypto.js';

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAuth(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded  = atob(header.slice(6));
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;
  const password = decoded.slice(colonIdx + 1);
  return password === (env.ADMIN_PASSWORD ?? '');
}

function authChallenge() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="DNS Report Admin"', 'Content-Type': 'text/plain' },
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────

function htmlResp(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function redirect(loc) {
  return new Response(null, { status: 303, headers: { Location: loc } });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Inline CSS (no external assets) ──────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
     background:#f0eced;color:#1a1a1a;font-size:14px;line-height:1.5}
a{color:#722F37;text-decoration:none}a:hover{text-decoration:underline}
nav{background:#722F37;padding:12px 28px;display:flex;align-items:center;gap:4px}
nav .brand{color:#fff;font-weight:700;font-size:16px;margin-right:20px;letter-spacing:.3px}
nav a{color:rgba(255,255,255,.75);font-size:13px;padding:5px 12px;border-radius:4px}
nav a:hover,nav a.active{color:#fff;background:rgba(255,255,255,.15);text-decoration:none}
.wrap{max-width:980px;margin:28px auto;padding:0 16px}
h1{font-size:20px;font-weight:700;color:#722F37;margin-bottom:20px}
.card{background:#fff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);
      padding:22px 24px;margin-bottom:20px}
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
.stat{background:#fff;border-left:4px solid #722F37;border-radius:4px;padding:14px 18px;
      box-shadow:0 1px 3px rgba(0,0,0,.07)}
.stat-val{font-size:28px;font-weight:700;color:#722F37;line-height:1}
.stat-lbl{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-top:5px}
table{width:100%;border-collapse:collapse}
th{background:#722F37;color:#fff;padding:8px 12px;text-align:left;
   font-size:11px;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
td{padding:8px 12px;border-bottom:1px solid #ede0e1;font-size:13px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:nth-child(even) td{background:#fdf9f9}
.btn{display:inline-block;padding:6px 14px;border-radius:4px;font-size:12px;font-weight:600;
     border:none;cursor:pointer;text-decoration:none;line-height:1.4}
.btn-primary{background:#722F37;color:#fff}.btn-primary:hover{background:#4A1E24;color:#fff;text-decoration:none}
.btn-danger{background:#C0392B;color:#fff}.btn-danger:hover{background:#922b21;color:#fff;text-decoration:none}
.btn-secondary{background:#e5d7d9;color:#4A1E24;border:1px solid #d5c2c5}
.btn-secondary:hover{background:#d5c2c5;color:#4A1E24;text-decoration:none}
.btn-sm{padding:3px 10px;font-size:11px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600}
.badge-green{background:#d1f0de;color:#1a5c32}
.badge-red{background:#fce8e8;color:#7b1c1c}
.badge-amber{background:#fef3d0;color:#7a4a00}
.badge-gray{background:#eee;color:#555}
.badge-blue{background:#ddeeff;color:#1a3d6e}
form label{display:block;font-size:12px;font-weight:600;color:#4A1E24;margin-bottom:4px;margin-top:16px}
form label:first-of-type{margin-top:0}
form input[type=text],form input[type=email],form input[type=password],
form input[type=date],form select,form textarea{
  width:100%;padding:8px 11px;border:1px solid #d5c2c5;border-radius:4px;
  font-size:13px;background:#fff;color:#1a1a1a}
form input:focus,form select:focus,form textarea:focus{
  outline:none;border-color:#722F37;box-shadow:0 0 0 2px rgba(114,47,55,.12)}
form textarea{min-height:80px;resize:vertical;font-family:inherit}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.hint{font-size:11px;color:#999;margin-top:3px;margin-bottom:0}
.actions{display:flex;gap:6px;align-items:center;white-space:nowrap}
.flash-error{background:#fce8e8;border:1px solid #f5c6cb;color:#7b1c1c;
             padding:10px 14px;border-radius:4px;margin-bottom:16px;font-size:13px}
.empty-row td{color:#999;text-align:center;padding:22px;font-style:italic}
code{font-family:monospace;font-size:12px;background:#f4eef0;padding:1px 5px;border-radius:3px}
`;

function layout(title, body, activePath = '') {
  const navLink = (href, label) =>
    `<a href="${href}" class="${activePath.startsWith(href) && href !== '/admin' || activePath === href ? 'active' : ''}">${label}</a>`;
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — DNS Report Admin</title>
<style>${CSS}</style></head>
<body>
<nav>
  <span class="brand">⚡ DNS Reports</span>
  ${navLink('/admin', 'Dashboard')}
  ${navLink('/admin/credentials', 'Credentials')}
  ${navLink('/admin/reports', 'Reports')}
  ${navLink('/admin/history', 'History')}
</nav>
<div class="wrap">
  <h1>${esc(title)}</h1>
  ${body}
</div>
</body></html>`;
}

function statusBadge(status) {
  const m = { sent: 'badge-green', failed: 'badge-red' };
  return `<span class="badge ${m[status] || 'badge-gray'}">${esc(status)}</span>`;
}

function freqBadge(f) {
  const m = { daily: 'badge-blue', weekly: 'badge-green', monthly: 'badge-gray' };
  return `<span class="badge ${m[f] || 'badge-gray'}">${esc(f)}</span>`;
}

function reportStatusBadge(row) {
  const today = new Date().toISOString().slice(0, 10);
  if (!row.enabled)                          return `<span class="badge badge-amber">Paused</span>`;
  if (row.end_date && today > row.end_date)  return `<span class="badge badge-red">Expired</span>`;
  if (row.start_date && today < row.start_date) return `<span class="badge badge-gray">Pending</span>`;
  return `<span class="badge badge-green">Active</span>`;
}

// ── Pages ─────────────────────────────────────────────────────────────────────

async function pageDashboard(env) {
  const [credRow, repRow, runRow, recentRuns] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM report_configs').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM report_runs').first(),
    env.DB.prepare(`
      SELECT rr.zone_name, rr.frequency, rr.period_start, rr.period_end,
             rr.status, rr.error_message, rr.sent_at, rc.label AS config_label
      FROM report_runs rr
      JOIN report_configs rc ON rc.id = rr.report_config_id
      ORDER BY rr.sent_at DESC LIMIT 10
    `).all(),
  ]);

  const rows = (recentRuns.results ?? []).map(r => `<tr>
    <td>${esc(r.config_label)}</td>
    <td>${esc(r.zone_name)}</td>
    <td>${freqBadge(r.frequency)}</td>
    <td style="font-size:12px">${esc(r.period_start)} – ${esc(r.period_end)}</td>
    <td>${statusBadge(r.status)}</td>
    <td style="font-size:11px;color:#888">${esc((r.sent_at ?? '').slice(0, 16))}</td>
    <td style="font-size:11px;color:#C0392B;max-width:180px;overflow:hidden;text-overflow:ellipsis">
      ${r.error_message ? esc(r.error_message.slice(0, 100)) : ''}
    </td>
  </tr>`).join('');

  const body = `
<div class="stat-grid">
  <div class="stat"><div class="stat-val">${credRow?.n ?? 0}</div><div class="stat-lbl">Credentials</div></div>
  <div class="stat"><div class="stat-val">${repRow?.n ?? 0}</div><div class="stat-lbl">Report Configs</div></div>
  <div class="stat"><div class="stat-val">${runRow?.n ?? 0}</div><div class="stat-lbl">Total Runs</div></div>
</div>
<div style="display:flex;gap:10px;margin-bottom:20px">
  <a class="btn btn-primary" href="/admin/reports/new">+ New Report</a>
  <a class="btn btn-secondary" href="/admin/credentials/new">+ New Credential</a>
</div>
<div class="card">
  <h2 style="font-size:14px;font-weight:700;color:#722F37;margin-bottom:14px">Recent Runs</h2>
  <table>
    <thead><tr><th>Config</th><th>Zone</th><th>Freq</th><th>Period</th><th>Status</th><th>Sent At</th><th>Error</th></tr></thead>
    <tbody>${rows || '<tr class="empty-row"><td colspan="7">No runs yet</td></tr>'}</tbody>
  </table>
  <div style="margin-top:12px"><a href="/admin/history" class="btn btn-secondary btn-sm">View all history →</a></div>
</div>`;

  return htmlResp(200, layout('Dashboard', body, '/admin'));
}

async function pageCredentialList(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, label, account_id, created_at FROM credentials ORDER BY label'
  ).all();

  const rows = (results ?? []).map(c => `<tr>
    <td><strong>${esc(c.label)}</strong></td>
    <td><code>${esc(c.account_id)}</code></td>
    <td style="font-size:11px;color:#888">${esc((c.created_at ?? '').slice(0, 16))}</td>
    <td class="actions">
      <a class="btn btn-secondary btn-sm" href="/admin/credentials/${c.id}/edit">Edit</a>
      <form method="POST" action="/admin/credentials/${c.id}" style="display:inline"
            onsubmit="return confirm('Delete this credential? Reports using it will stop working.')">
        <input type="hidden" name="_method" value="DELETE">
        <button class="btn btn-danger btn-sm" type="submit">Delete</button>
      </form>
    </td>
  </tr>`).join('');

  const body = `
<div style="margin-bottom:16px">
  <a class="btn btn-primary" href="/admin/credentials/new">+ New Credential</a>
</div>
<p style="font-size:13px;color:#555;margin-bottom:16px">
  Each credential holds a Cloudflare API token (stored encrypted) and account ID.
  Required token scopes: <code>Zone.DNS:Read</code> · <code>Zone.Zone:Read</code> · <code>Zone.Analytics:Read</code>.
  Add <code>Account.Account Analytics:Read</code> for Gateway/ZTNA data.
</p>
<div class="card">
  <table>
    <thead><tr><th>Label</th><th>Account ID</th><th>Created</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr class="empty-row"><td colspan="4">No credentials yet</td></tr>'}</tbody>
  </table>
</div>`;

  return htmlResp(200, layout('Credentials', body, '/admin/credentials'));
}

async function pageCredentialForm(env, id = null, flash = '') {
  let cred = null;
  if (id) {
    cred = await env.DB.prepare('SELECT id, label, account_id FROM credentials WHERE id=?').bind(id).first();
    if (!cred) return htmlResp(404, layout('Not Found', '<p>Credential not found.</p>'));
  }
  const action = id ? `/admin/credentials/${id}` : '/admin/credentials';

  const body = `
${flash}
<div class="card">
<form method="POST" action="${action}">
  ${id ? '<input type="hidden" name="_method" value="PUT">' : ''}
  <label>Label</label>
  <input type="text" name="label" required value="${esc(cred?.label ?? '')}" placeholder="e.g. My Business">
  <p class="hint">A friendly name shown in the admin UI and report history.</p>

  <label>Cloudflare Account ID</label>
  <input type="text" name="account_id" required value="${esc(cred?.account_id ?? '')}"
         placeholder="9f86f3b73ff40da02bce7f31c93e98bd" style="font-family:monospace">
  <p class="hint">Found in the Cloudflare dashboard URL or under Account Home → Overview.</p>

  <label>${id ? 'New API Token (leave blank to keep existing)' : 'Cloudflare API Token'}</label>
  <input type="password" name="api_token" ${id ? '' : 'required'} autocomplete="new-password"
         placeholder="${id ? '(unchanged)' : 'eyJhbGciOiJFZERTQSJ9...'}">
  <p class="hint">
    Create at <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">My Profile → API Tokens</a>.
    Stored AES-256-GCM encrypted — never visible after saving.
  </p>

  <div style="margin-top:22px;display:flex;gap:12px">
    <button class="btn btn-primary" type="submit">${id ? 'Save Changes' : 'Add Credential'}</button>
    <a class="btn btn-secondary" href="/admin/credentials">Cancel</a>
  </div>
</form>
</div>`;

  return htmlResp(200, layout(id ? 'Edit Credential' : 'New Credential', body, '/admin/credentials'));
}

async function pageReportList(env) {
  const { results } = await env.DB.prepare(`
    SELECT rc.id, rc.label, rc.zone_name, rc.frequency, rc.recipients,
           rc.start_date, rc.end_date, rc.enabled, c.label AS cred_label
    FROM report_configs rc
    JOIN credentials c ON c.id = rc.credential_id
    ORDER BY rc.label
  `).all();

  const rows = (results ?? []).map(r => {
    let recipStr = '';
    try { recipStr = JSON.parse(r.recipients).join(', '); } catch { recipStr = r.recipients; }
    return `<tr>
      <td><strong>${esc(r.label)}</strong></td>
      <td style="font-size:12px">${esc(r.zone_name)}</td>
      <td>${freqBadge(r.frequency)}</td>
      <td style="font-size:11px">${esc(recipStr)}</td>
      <td style="font-size:12px">${r.end_date ? esc(r.end_date) : '—'}</td>
      <td>${reportStatusBadge(r)}</td>
      <td class="actions">
        <a class="btn btn-secondary btn-sm" href="/admin/reports/${r.id}/edit">Edit</a>
        <form method="POST" action="/admin/reports/${r.id}" style="display:inline">
          <input type="hidden" name="_method" value="${r.enabled ? 'PAUSE' : 'RESUME'}">
          <button class="btn btn-secondary btn-sm">${r.enabled ? 'Pause' : 'Resume'}</button>
        </form>
        <form method="POST" action="/admin/reports/${r.id}" style="display:inline"
              onsubmit="return confirm('Delete this report configuration?')">
          <input type="hidden" name="_method" value="DELETE">
          <button class="btn btn-danger btn-sm">Delete</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  const body = `
<div style="margin-bottom:16px">
  <a class="btn btn-primary" href="/admin/reports/new">+ New Report</a>
</div>
<div class="card">
  <table>
    <thead><tr>
      <th>Label</th><th>Zone</th><th>Frequency</th><th>Recipients</th>
      <th>End Date</th><th>Status</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows || '<tr class="empty-row"><td colspan="7">No reports configured yet</td></tr>'}</tbody>
  </table>
</div>`;

  return htmlResp(200, layout('Reports', body, '/admin/reports'));
}

async function pageReportForm(env, id = null, flash = '') {
  const { results: creds } = await env.DB.prepare('SELECT id, label FROM credentials ORDER BY label').all();
  let rep = null;
  if (id) {
    rep = await env.DB.prepare('SELECT * FROM report_configs WHERE id=?').bind(id).first();
    if (!rep) return htmlResp(404, layout('Not Found', '<p>Report not found.</p>'));
  }

  const credOpts = (creds ?? []).map(c =>
    `<option value="${c.id}" ${rep?.credential_id == c.id ? 'selected' : ''}>${esc(c.label)}</option>`
  ).join('');

  let recipStr = '';
  if (rep?.recipients) {
    try { recipStr = JSON.parse(rep.recipients).join('\n'); } catch { recipStr = rep.recipients; }
  }

  const today = new Date().toISOString().slice(0, 10);
  const action = id ? `/admin/reports/${id}` : '/admin/reports';

  const body = `
${flash}
${creds.length === 0 ? '<div class="flash-error">No credentials exist yet — <a href="/admin/credentials/new">add one first</a> before creating a report.</div>' : ''}
<div class="card">
<form method="POST" action="${action}">
  ${id ? '<input type="hidden" name="_method" value="PUT">' : ''}

  <div class="form-row">
    <div>
      <label>Report Label</label>
      <input type="text" name="label" required value="${esc(rep?.label ?? '')}" placeholder="e.g. My Business — Weekly">
    </div>
    <div>
      <label>Credential (API Token)</label>
      <select name="credential_id" required>
        <option value="">— select —</option>
        ${credOpts}
      </select>
    </div>
  </div>

  <div class="form-row">
    <div>
      <label>Zone ID</label>
      <input type="text" name="zone_id" required value="${esc(rep?.zone_id ?? '')}"
             placeholder="1a240735cef3fb59970c345bee532128" style="font-family:monospace">
      <p class="hint">Cloudflare dashboard → your domain → Overview (right sidebar).</p>
    </div>
    <div>
      <label>Domain Name</label>
      <input type="text" name="zone_name" required value="${esc(rep?.zone_name ?? '')}" placeholder="example.com">
      <p class="hint">Display only — used in email subject and report header.</p>
    </div>
  </div>

  <div class="form-row">
    <div>
      <label>Frequency</label>
      <select name="frequency" required>
        <option value="daily"   ${rep?.frequency === 'daily'   ? 'selected' : ''}>Daily — every morning</option>
        <option value="weekly"  ${rep?.frequency === 'weekly'  ? 'selected' : ''}>Weekly — every Monday</option>
        <option value="monthly" ${!rep || rep?.frequency === 'monthly' ? 'selected' : ''}>Monthly — 1st of month</option>
      </select>
    </div>
    <div>
      <label>Email Subject Prefix</label>
      <input type="text" name="subject_prefix" value="${esc(rep?.subject_prefix ?? '[DNS Report]')}">
    </div>
  </div>

  <label>Report Title <span style="font-weight:400;color:#888">(shown in email header)</span></label>
  <input type="text" name="report_title" value="${esc(rep?.report_title ?? 'DNS Report')}" placeholder="e.g. My Business Analytics">

  <label>Recipients <span style="font-weight:400;color:#888">(one email address per line)</span></label>
  <textarea name="recipients" required placeholder="admin@example.com&#10;owner@example.com">${esc(recipStr)}</textarea>

  <div class="form-row">
    <div>
      <label>Start Date</label>
      <input type="date" name="start_date" value="${esc(rep?.start_date ?? today)}">
      <p class="hint">Reports will not be sent before this date.</p>
    </div>
    <div>
      <label>End Date <span style="font-weight:400;color:#888">(optional — leave blank = run forever)</span></label>
      <input type="date" name="end_date" value="${esc(rep?.end_date ?? '')}">
      <p class="hint">Reports auto-expire after this date. Useful for trials or fixed-term contracts.</p>
    </div>
  </div>

  <div style="margin-top:22px;display:flex;gap:12px">
    <button class="btn btn-primary">${id ? 'Save Changes' : 'Create Report'}</button>
    <a class="btn btn-secondary" href="/admin/reports">Cancel</a>
  </div>
</form>
</div>`;

  return htmlResp(200, layout(id ? 'Edit Report' : 'New Report', body, '/admin/reports'));
}

async function pageHistory(env) {
  const { results } = await env.DB.prepare(`
    SELECT rr.zone_name, rr.frequency, rr.period_start, rr.period_end,
           rr.status, rr.error_message, rr.sent_at, rc.label AS config_label
    FROM report_runs rr
    JOIN report_configs rc ON rc.id = rr.report_config_id
    ORDER BY rr.sent_at DESC LIMIT 100
  `).all();

  const rows = (results ?? []).map(r => `<tr>
    <td>${esc(r.config_label)}</td>
    <td style="font-size:12px">${esc(r.zone_name)}</td>
    <td>${freqBadge(r.frequency)}</td>
    <td style="font-size:12px">${esc(r.period_start)} – ${esc(r.period_end)}</td>
    <td>${statusBadge(r.status)}</td>
    <td style="font-size:11px;color:#888">${esc((r.sent_at ?? '').slice(0, 16))}</td>
    <td style="font-size:11px;color:#C0392B;max-width:200px;overflow:hidden;text-overflow:ellipsis">
      ${r.error_message ? esc(r.error_message.slice(0, 150)) : ''}
    </td>
  </tr>`).join('');

  const body = `
<div class="card">
  <table>
    <thead><tr><th>Config</th><th>Zone</th><th>Freq</th><th>Period</th><th>Status</th><th>Sent At</th><th>Error</th></tr></thead>
    <tbody>${rows || '<tr class="empty-row"><td colspan="7">No runs yet</td></tr>'}</tbody>
  </table>
</div>`;

  return htmlResp(200, layout('Run History', body, '/admin/history'));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createCredential(request, env) {
  const form    = await request.formData();
  const label   = form.get('label')?.trim()      ?? '';
  const acctId  = form.get('account_id')?.trim() ?? '';
  const token   = form.get('api_token')?.trim()  ?? '';

  if (!label || !acctId || !token)
    return pageCredentialForm(env, null, '<div class="flash-error">All fields are required.</div>');
  if (!env.TOKEN_ENCRYPTION_KEY)
    return pageCredentialForm(env, null, '<div class="flash-error">TOKEN_ENCRYPTION_KEY secret is not configured. Set it via <code>wrangler secret put TOKEN_ENCRYPTION_KEY</code>.</div>');

  const enc = await encryptToken(token, env.TOKEN_ENCRYPTION_KEY);
  await env.DB.prepare('INSERT INTO credentials (label, account_id, encrypted_token) VALUES (?,?,?)')
    .bind(label, acctId, enc).run();
  return redirect('/admin/credentials');
}

async function updateCredential(request, env, id) {
  const form   = await request.formData();
  const label  = form.get('label')?.trim()      ?? '';
  const acctId = form.get('account_id')?.trim() ?? '';
  const token  = form.get('api_token')?.trim()  ?? '';

  if (!label || !acctId)
    return pageCredentialForm(env, id, '<div class="flash-error">Label and Account ID are required.</div>');

  if (token) {
    if (!env.TOKEN_ENCRYPTION_KEY)
      return pageCredentialForm(env, id, '<div class="flash-error">TOKEN_ENCRYPTION_KEY secret is not set.</div>');
    const enc = await encryptToken(token, env.TOKEN_ENCRYPTION_KEY);
    await env.DB.prepare(`UPDATE credentials SET label=?,account_id=?,encrypted_token=?,updated_at=datetime('now') WHERE id=?`)
      .bind(label, acctId, enc, id).run();
  } else {
    await env.DB.prepare(`UPDATE credentials SET label=?,account_id=?,updated_at=datetime('now') WHERE id=?`)
      .bind(label, acctId, id).run();
  }
  return redirect('/admin/credentials');
}

async function deleteCredential(env, id) {
  try {
    await env.DB.prepare('DELETE FROM credentials WHERE id=?').bind(id).run();
  } catch {
    // FK constraint — reports still reference this credential
  }
  return redirect('/admin/credentials');
}

function extractReportForm(form) {
  const label        = form.get('label')?.trim()          ?? '';
  const credentialId = parseInt(form.get('credential_id') ?? '0', 10);
  const zoneId       = form.get('zone_id')?.trim()        ?? '';
  const zoneName     = form.get('zone_name')?.trim()      ?? '';
  const frequency    = form.get('frequency')?.trim()      ?? '';
  const subjectPfx   = form.get('subject_prefix')?.trim() || '[DNS Report]';
  const reportTitle  = form.get('report_title')?.trim()   || 'DNS Report';
  const startDate    = form.get('start_date')?.trim()     || new Date().toISOString().slice(0, 10);
  const endDate      = form.get('end_date')?.trim()       || null;
  const recipients   = (form.get('recipients') ?? '')
    .split(/[\n,]+/).map(e => e.trim()).filter(Boolean);

  if (!label || !credentialId || !zoneId || !zoneName || !frequency || !recipients.length)
    return { ok: false, error: 'All required fields must be filled in.' };

  return { ok: true, values: { label, credentialId, zoneId, zoneName, frequency,
    recipients: JSON.stringify(recipients), subjectPfx, reportTitle, startDate, endDate } };
}

async function createReport(request, env) {
  const form = await request.formData();
  const d    = extractReportForm(form);
  if (!d.ok) return pageReportForm(env, null, `<div class="flash-error">${esc(d.error)}</div>`);
  const v = d.values;
  await env.DB.prepare(`
    INSERT INTO report_configs
      (credential_id,label,zone_id,zone_name,frequency,recipients,start_date,end_date,subject_prefix,report_title)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(v.credentialId,v.label,v.zoneId,v.zoneName,v.frequency,
          v.recipients,v.startDate,v.endDate,v.subjectPfx,v.reportTitle).run();
  return redirect('/admin/reports');
}

async function updateReport(request, env, id) {
  const form = await request.formData();
  const d    = extractReportForm(form);
  if (!d.ok) return pageReportForm(env, id, `<div class="flash-error">${esc(d.error)}</div>`);
  const v = d.values;
  await env.DB.prepare(`
    UPDATE report_configs
    SET credential_id=?,label=?,zone_id=?,zone_name=?,frequency=?,recipients=?,
        start_date=?,end_date=?,subject_prefix=?,report_title=?,updated_at=datetime('now')
    WHERE id=?
  `).bind(v.credentialId,v.label,v.zoneId,v.zoneName,v.frequency,
          v.recipients,v.startDate,v.endDate,v.subjectPfx,v.reportTitle,id).run();
  return redirect('/admin/reports');
}

async function toggleReport(env, id, enable) {
  await env.DB.prepare(`UPDATE report_configs SET enabled=?,updated_at=datetime('now') WHERE id=?`)
    .bind(enable ? 1 : 0, id).run();
  return redirect('/admin/reports');
}

async function deleteReport(env, id) {
  await env.DB.prepare('DELETE FROM report_configs WHERE id=?').bind(id).run();
  return redirect('/admin/reports');
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handleAdmin(request, env) {
  if (!requireAuth(request, env)) return authChallenge();

  const url    = new URL(request.url);
  const path   = url.pathname.replace(/\/$/, '') || '/admin';
  const method = request.method.toUpperCase();

  // Peek at _method override for POST requests
  let override = '';
  if (method === 'POST') {
    const fd = await request.clone().formData();
    override = (fd.get('_method') ?? '').toUpperCase();
  }
  const effective = override || method;

  // ── Credentials ────────────────────────────────────────────────────────────
  if (path === '/admin/credentials') {
    if (method === 'GET')         return pageCredentialList(env);
    if (effective === 'POST')     return createCredential(request, env);
  }
  if (path === '/admin/credentials/new' && method === 'GET')
    return pageCredentialForm(env);

  const credM = path.match(/^\/admin\/credentials\/(\d+)(\/edit)?$/);
  if (credM) {
    const id = parseInt(credM[1], 10);
    if (method === 'GET')         return pageCredentialForm(env, id);
    if (effective === 'PUT')      return updateCredential(request, env, id);
    if (effective === 'DELETE')   return deleteCredential(env, id);
  }

  // ── Reports ────────────────────────────────────────────────────────────────
  if (path === '/admin/reports') {
    if (method === 'GET')         return pageReportList(env);
    if (effective === 'POST')     return createReport(request, env);
  }
  if (path === '/admin/reports/new' && method === 'GET')
    return pageReportForm(env);

  const repM = path.match(/^\/admin\/reports\/(\d+)(\/edit)?$/);
  if (repM) {
    const id = parseInt(repM[1], 10);
    if (method === 'GET')         return pageReportForm(env, id);
    if (effective === 'PUT')      return updateReport(request, env, id);
    if (effective === 'PAUSE')    return toggleReport(env, id, false);
    if (effective === 'RESUME')   return toggleReport(env, id, true);
    if (effective === 'DELETE')   return deleteReport(env, id);
  }

  // ── History / Dashboard ────────────────────────────────────────────────────
  if (path === '/admin/history' && method === 'GET') return pageHistory(env);
  if (path === '/admin'         && method === 'GET') return pageDashboard(env);

  return htmlResp(404, layout('Not Found', '<p>Page not found.</p>'));
}
