/**
 * HTML email template for the Workers deployment.
 *
 * Since Workers cannot generate PDFs without the Browser Rendering API, the
 * full report is delivered as a rich HTML email (no PDF attachment). The
 * layout uses table-based structure for broad email client compatibility and
 * inline-style fallbacks for clients that strip <head> styles.
 */

// ── Color constants ────────────────────────────────────────────────────────
const C = {
  burgundy:      '#722F37',
  burgundyDark:  '#4A1E24',
  burgundyLight: '#9B4D57',
  blue:          '#2E6DA4',
  blueLight:     '#5BA3D9',
  green:         '#2D7D46',
  greenLight:    '#52B775',
  amber:         '#D97706',
  red:           '#C0392B',
  near_black:    '#1a1a1a',
  gray:          '#666666',
  gray_light:    '#999999',
  bg:            '#f0eced',
  bg_light:      '#f8f5f6',
  border:        '#e5d7d9',
};

/** Format a large number as e.g. "1.2M" or "45K" */
function human(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** Build a CSS-only horizontal bar chart row. */
function barRow(label, count, maxCount, color = C.blue) {
  const pct     = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
  const display = label.length > 55 ? label.slice(0, 55) + '…' : label;
  return `
    <tr>
      <td style="padding:4px 10px 4px 0; font-size:11px; color:${C.near_black};
                 white-space:nowrap; overflow:hidden; max-width:220px; font-family:monospace;"
          title="${label}">${display}</td>
      <td style="padding:4px 0; width:100%;">
        <div style="background:${C.bg}; border-radius:9px; overflow:hidden; height:14px;">
          <div style="background:${color}; width:${pct}%; height:100%;
                      border-radius:9px; min-width:2px;"></div>
        </div>
      </td>
      <td style="padding:4px 0 4px 10px; font-size:11px; color:${C.gray}; white-space:nowrap;">
        ${human(count)}
      </td>
    </tr>`;
}

/** Compute summary metrics from analytics data. */
function computeMetrics(analytics, dnsRecords) {
  const byDate = analytics.byDate ?? [];
  const byCode = analytics.byResponseCode ?? [];

  const total    = byDate.reduce((s, d) => s + d.sum.queryCount, 0);
  const uncached = byDate.reduce((s, d) => s + (d.sum.uncachedCount ?? 0), 0);
  const codeMap  = Object.fromEntries(byCode.map(d => [d.dimensions.responseCode, d.sum.queryCount]));

  return {
    total,
    cached:      total - uncached,
    uncached,
    cacheHitPct: total > 0 ? ((total - uncached) / total * 100).toFixed(1) : '0.0',
    noerror:     codeMap['NOERROR']  ?? 0,
    nxdomain:    codeMap['NXDOMAIN'] ?? 0,
    servfail:    codeMap['SERVFAIL'] ?? 0,
    nxdomainPct: total > 0 ? (((codeMap['NXDOMAIN'] ?? 0) / total) * 100).toFixed(2) : '0.00',
    successPct:  total > 0 ? (((codeMap['NOERROR']  ?? 0) / total) * 100).toFixed(1) : '0.0',
    recordCount: dnsRecords.length,
  };
}

/** Pill badge HTML. */
function pill(text, bg, fg) {
  return `<span style="display:inline-block; padding:2px 8px; border-radius:10px;
                       font-size:10px; font-weight:600; letter-spacing:0.3px;
                       background:${bg}; color:${fg};">${text}</span>`;
}

const CODE_META = {
  NOERROR:  { label: 'OK',             bg: '#d1f0de', fg: '#1a5c32' },
  NXDOMAIN: { label: 'Not Found',      bg: '#fce8e8', fg: '#7b1c1c' },
  SERVFAIL: { label: 'Server Failure', bg: '#fce8e8', fg: '#7b1c1c' },
  REFUSED:  { label: 'Refused',        bg: '#fef3d0', fg: '#7a4a00' },
};

/**
 * Render the full HTML email.
 *
 * @param {object} p - Template parameters.
 * @returns {string} Complete HTML email string.
 */
export function renderEmail({
  accountName,
  zoneName,
  frequency,
  period,
  metrics: rawMetrics,
  analytics,
  dnsRecords,
  dnssec,
  reportTitle,
  generatedAt,
}) {
  const m    = computeMetrics(analytics, dnsRecords);
  const freq = frequency.charAt(0).toUpperCase() + frequency.slice(1);

  // ── Top queried domains bar chart ──────────────────────────────────────────
  const topNames  = analytics.byQueryName ?? [];
  const maxNames  = topNames[0]?.sum.queryCount ?? 1;
  const topBars   = topNames.slice(0, 12)
    .map(d => barRow(d.dimensions.queryName, d.sum.queryCount, maxNames, C.blue))
    .join('');

  // ── Query type bar chart ───────────────────────────────────────────────────
  const byType   = analytics.byQueryType ?? [];
  const maxType  = byType[0]?.sum.queryCount ?? 1;
  const typeBars = byType.slice(0, 8)
    .map(d => barRow(d.dimensions.queryType, d.sum.queryCount, maxType, C.burgundy))
    .join('');

  // ── Daily volume mini-bars ─────────────────────────────────────────────────
  const byDate  = analytics.byDate ?? [];
  const maxDay  = Math.max(...byDate.map(d => d.sum.queryCount), 1);
  const dayBars = byDate.map(d => {
    const pct = Math.round((d.sum.queryCount / maxDay) * 100);
    const dt  = d.dimensions.date.slice(5);  // MM-DD
    return `<td style="text-align:center; vertical-align:bottom; padding:0 2px; width:${Math.floor(100 / Math.max(byDate.length,1))}%;">
      <div style="background:${C.burgundy}; height:${Math.max(pct * 0.6, 2)}px; border-radius:2px 2px 0 0; opacity:0.85;"></div>
      <div style="font-size:8px; color:${C.gray_light}; margin-top:2px;">${dt}</div>
    </td>`;
  }).join('');

  // ── Response code rows ─────────────────────────────────────────────────────
  const codeRows = (analytics.byResponseCode ?? []).slice(0, 6).map(d => {
    const code  = d.dimensions.responseCode;
    const count = d.sum.queryCount;
    const pct   = m.total > 0 ? ((count / m.total) * 100).toFixed(2) : '0.00';
    const meta  = CODE_META[code] ?? { label: code, bg: '#f0f0f0', fg: '#555' };
    return `<tr style="border-bottom:1px solid ${C.border};">
      <td style="padding:7px 12px; font-family:monospace; font-size:12px; font-weight:600;">${code}</td>
      <td style="padding:7px 12px; font-size:12px;">${human(count)}</td>
      <td style="padding:7px 12px; font-size:12px;">${pct}%</td>
      <td style="padding:7px 12px;">${pill(meta.label, meta.bg, meta.fg)}</td>
    </tr>`;
  }).join('');

  // ── DNS records table (capped at 50 for email length) ─────────────────────
  const sortedRecords = [...dnsRecords]
    .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name))
    .slice(0, 50);

  const recordRows = sortedRecords.map(r => {
    const content = r.content?.length > 60 ? r.content.slice(0, 60) + '…' : (r.content ?? '');
    const ttl     = r.ttl === 1 ? 'Auto' : String(r.ttl);
    const proxied = r.proxiable && r.proxied
      ? `<span style="color:#F6821F; font-weight:600;">✓ Proxied</span>`
      : `<span style="color:${C.gray_light};">DNS Only</span>`;
    return `<tr style="border-bottom:1px solid ${C.border};">
      <td style="padding:5px 10px;">${pill(r.type, '#ddeeff', '#1a3d6e')}</td>
      <td style="padding:5px 10px; font-family:monospace; font-size:11px;">${r.name}</td>
      <td style="padding:5px 10px; font-family:monospace; font-size:11px; color:#333;">${content}</td>
      <td style="padding:5px 10px; font-size:11px; color:${C.gray};">${ttl}</td>
      <td style="padding:5px 10px; font-size:11px;">${proxied}</td>
    </tr>`;
  }).join('');

  // ── DNSSEC ─────────────────────────────────────────────────────────────────
  const dsStatus  = (dnssec?.status ?? 'unknown').toLowerCase();
  const dsColor   = dsStatus === 'active' ? C.green : (dsStatus === 'unknown' ? C.amber : C.red);
  const dsLabel   = dsStatus === 'active' ? 'Active — Zone is DNSSEC signed' :
                    dsStatus === 'unknown' ? 'Status unknown' : 'Disabled';

  // ── Summary card helper ────────────────────────────────────────────────────
  function card(value, label, color = C.burgundy) {
    return `<td style="width:25%; padding:0 5px 0 0;">
      <div style="background:white; border-left:4px solid ${color}; padding:14px 16px;
                  border-radius:3px; box-shadow:0 1px 3px rgba(0,0,0,0.07);">
        <div style="font-size:22px; font-weight:700; color:${color}; line-height:1;">
          ${value}
        </div>
        <div style="font-size:10px; color:${C.gray_light}; text-transform:uppercase;
                    letter-spacing:0.5px; margin-top:5px;">${label}</div>
      </div>
    </td>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${reportTitle} — ${freq} DNS Report</title>
<style>
  @media (max-width:600px) {
    .resp-stack { display:block !important; width:100% !important; }
    .resp-hide  { display:none !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background:${C.bg};
             font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">

  <table width="740" cellpadding="0" cellspacing="0"
         style="max-width:740px; width:100%; background:#ffffff;
                border-radius:6px; overflow:hidden;
                box-shadow:0 2px 12px rgba(0,0,0,0.10);">

    <!-- ╔═══════════════════════════════ HEADER ════════════════════════╗ -->
    <tr>
      <td style="background:${C.burgundy}; padding:28px 32px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:2px;
                    color:rgba(255,255,255,0.65); margin-bottom:6px;">
          Cloudflare DNS Analytics
        </div>
        <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:700;">
          ${reportTitle}
        </h1>
        <div style="margin-top:8px; font-size:12px; color:rgba(255,255,255,0.8);
                    display:flex; gap:18px; flex-wrap:wrap;">
          <span>&#9656; ${zoneName}</span>
          <span>&#9656; ${freq} Report</span>
          <span>&#9656; ${period.start} — ${period.end}</span>
        </div>
        <div style="display:inline-block; margin-top:12px; background:rgba(255,255,255,0.18);
                    border:1px solid rgba(255,255,255,0.35); border-radius:12px;
                    padding:3px 12px; font-size:9px; font-weight:700;
                    letter-spacing:0.8px; color:#fff; text-transform:uppercase;">
          ${freq}
        </div>
      </td>
    </tr>

    <!-- period sub-bar -->
    <tr>
      <td style="background:${C.burgundyDark}; padding:7px 32px; font-size:11px;
                 color:rgba(255,255,255,0.75);">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>${period.start} to ${period.end}</td>
          <td style="text-align:right;">${generatedAt}</td>
        </tr></table>
      </td>
    </tr>

    <!-- ╔═══════════════════════════ SUMMARY CARDS ═════════════════════╗ -->
    <tr>
      <td style="background:${C.bg_light}; padding:20px 32px; border-bottom:1px solid ${C.border};">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          ${card(human(m.total),      'Total Queries',   C.burgundy)}
          ${card(m.cacheHitPct + '%', 'Cache Hit Rate',  C.blue)}
          ${card(m.successPct + '%',  'Success Rate',    C.green)}
          ${card(m.nxdomainPct + '%', 'NXDOMAIN Rate',   parseFloat(m.nxdomainPct) > 5 ? C.amber : C.near_black)}
        </tr></table>
      </td>
    </tr>

    <!-- ╔══════════════════════════ QUERY VOLUME ═══════════════════════╗ -->
    ${byDate.length ? `
    <tr><td style="padding:22px 32px 0;">
      <div style="font-size:12px; font-weight:700; color:${C.burgundy}; text-transform:uppercase;
                  letter-spacing:0.5px; border-bottom:2px solid ${C.burgundy}; padding-bottom:4px;
                  margin-bottom:12px;">Query Volume by Day</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr style="vertical-align:bottom; height:80px;">${dayBars}</tr>
      </table>
    </td></tr>` : ''}

    <!-- ╔═════════════════════════ TOP DOMAINS ═════════════════════════╗ -->
    ${topBars ? `
    <tr><td style="padding:22px 32px 0;">
      <div style="font-size:12px; font-weight:700; color:${C.burgundy}; text-transform:uppercase;
                  letter-spacing:0.5px; border-bottom:2px solid ${C.burgundy}; padding-bottom:4px;
                  margin-bottom:12px;">Top Queried Domains</div>
      <table width="100%" cellpadding="0" cellspacing="0">${topBars}</table>
    </td></tr>` : ''}

    <!-- ╔════════════════════════ QUERY TYPES ══════════════════════════╗ -->
    ${typeBars ? `
    <tr><td style="padding:22px 32px 0;">
      <div style="font-size:12px; font-weight:700; color:${C.burgundy}; text-transform:uppercase;
                  letter-spacing:0.5px; border-bottom:2px solid ${C.burgundy}; padding-bottom:4px;
                  margin-bottom:12px;">Record Type Distribution</div>
      <table width="100%" cellpadding="0" cellspacing="0">${typeBars}</table>
    </td></tr>` : ''}

    <!-- ╔══════════════════════ RESPONSE CODES ═════════════════════════╗ -->
    ${codeRows ? `
    <tr><td style="padding:22px 32px 0;">
      <div style="font-size:12px; font-weight:700; color:${C.burgundy}; text-transform:uppercase;
                  letter-spacing:0.5px; border-bottom:2px solid ${C.burgundy}; padding-bottom:4px;
                  margin-bottom:12px;">Response Code Analysis</div>
      <div style="border:1px solid ${C.border}; border-radius:4px; overflow:hidden;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <thead>
            <tr style="background:${C.burgundy};">
              <th style="padding:7px 12px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; letter-spacing:0.4px;">Code</th>
              <th style="padding:7px 12px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; letter-spacing:0.4px;">Count</th>
              <th style="padding:7px 12px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; letter-spacing:0.4px;">Share</th>
              <th style="padding:7px 12px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; letter-spacing:0.4px;">Status</th>
            </tr>
          </thead>
          <tbody>${codeRows}</tbody>
        </table>
      </div>
    </td></tr>` : ''}

    <!-- ╔═══════════════════════ DNSSEC STATUS ═════════════════════════╗ -->
    <tr><td style="padding:22px 32px 0;">
      <div style="font-size:12px; font-weight:700; color:${C.burgundy}; text-transform:uppercase;
                  letter-spacing:0.5px; border-bottom:2px solid ${C.burgundy}; padding-bottom:4px;
                  margin-bottom:12px;">DNSSEC Status</div>
      <div style="border:1px solid ${C.border}; border-radius:4px; padding:14px 18px;
                  background:${C.bg_light}; display:flex; align-items:center; gap:12px;">
        <div style="width:12px; height:12px; border-radius:50%; background:${dsColor};
                    flex-shrink:0;"></div>
        <div>
          <strong style="font-size:12px;">${dsLabel}</strong>
          ${dnssec?.ds_record ? `<div style="font-family:monospace; font-size:10px; color:${C.gray}; margin-top:3px;">DS: ${dnssec.ds_record}</div>` : ''}
        </div>
      </div>
    </td></tr>

    <!-- ╔══════════════════════ DNS RECORDS TABLE ══════════════════════╗ -->
    ${recordRows ? `
    <tr><td style="padding:22px 32px 0;">
      <div style="font-size:12px; font-weight:700; color:${C.burgundy}; text-transform:uppercase;
                  letter-spacing:0.5px; border-bottom:2px solid ${C.burgundy}; padding-bottom:4px;
                  margin-bottom:12px;">
        DNS Records Inventory (${dnsRecords.length} total${dnsRecords.length > 50 ? ', showing top 50' : ''})
      </div>
      <div style="border:1px solid ${C.border}; border-radius:4px; overflow:hidden;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <thead>
            <tr style="background:${C.burgundy};">
              <th style="padding:7px 10px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; width:10%;">Type</th>
              <th style="padding:7px 10px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; width:28%;">Name</th>
              <th style="padding:7px 10px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase;">Content</th>
              <th style="padding:7px 10px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; width:8%;">TTL</th>
              <th style="padding:7px 10px; text-align:left; color:#fff; font-size:10px;
                         text-transform:uppercase; width:10%;">Proxy</th>
            </tr>
          </thead>
          <tbody>${recordRows}</tbody>
        </table>
      </div>
    </td></tr>` : ''}

    <!-- ╔════════════════════════════ FOOTER ═══════════════════════════╗ -->
    <tr>
      <td style="padding:20px 32px; border-top:2px solid ${C.border}; margin-top:24px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:10px; color:${C.gray_light};">
            ${zoneName} &bull; ${freq} Report &bull; ${period.start} – ${period.end}
          </td>
          <td style="text-align:right; font-size:10px; color:${C.gray_light};">
            CloudflareDNS-Auto-Report
          </td>
        </tr></table>
      </td>
    </tr>

  </table><!-- /inner -->
</td></tr>
</table><!-- /outer -->
</body>
</html>`;
}
