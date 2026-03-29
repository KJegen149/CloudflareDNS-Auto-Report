/**
 * HTML email template for the Workers deployment.
 *
 * Table-based layout with inline styles for broad email client compatibility.
 * CSS-only bar charts and SVG donut chart (no images, no external resources).
 * All sections are conditional on data availability.
 */

// ── Color palette ─────────────────────────────────────────────────────────────
const C = {
  burgundy:     '#722F37',
  burgundyDark: '#4A1E24',
  blue:         '#2E6DA4',
  green:        '#2D7D46',
  amber:        '#D97706',
  red:          '#C0392B',
  purple:       '#6B3FA0',
  gray:         '#666666',
  grayLight:    '#999999',
  nearBlack:    '#1a1a1a',
  bg:           '#f0eced',
  bgLight:      '#f8f5f6',
  border:       '#e5d7d9',
};

// Ten distinct colors for the country pie chart
const PIE_COLORS = [
  '#722F37', '#2E6DA4', '#2D7D46', '#D97706', '#6B3FA0',
  '#C0392B', '#1a3a5c', '#E67E22', '#156D3B', '#8E44AD',
];

// ── Formatters ────────────────────────────────────────────────────────────────

function human(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function humanBytes(n) {
  n = Number(n) || 0;
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024)         return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function sectionTitle(text) {
  return `<tr><td style="padding:22px 32px 10px;">
    <div style="font-size:11px;font-weight:700;color:${C.burgundy};text-transform:uppercase;
                letter-spacing:0.6px;border-bottom:2px solid ${C.burgundy};padding-bottom:5px;">
      ${text}
    </div>
  </td></tr>`;
}

function pill(text, bg, fg) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;
    font-size:10px;font-weight:600;letter-spacing:0.3px;background:${bg};color:${fg};">${text}</span>`;
}

/**
 * One horizontal bar row for a CSS bar chart.
 */
function barRow(label, count, maxCount, color) {
  const pct     = maxCount > 0 ? Math.max(Math.round((count / maxCount) * 100), 2) : 2;
  const display = label.length > 50 ? label.slice(0, 50) + '…' : label;
  return `<tr>
    <td style="padding:3px 10px 3px 0;font-size:11px;color:${C.nearBlack};white-space:nowrap;
               width:180px;overflow:hidden;max-width:180px;" title="${label}">${display}</td>
    <td style="padding:3px 0;width:100%;">
      <div style="background:#ede0e1;border-radius:8px;height:13px;overflow:hidden;">
        <div style="background:${color};width:${pct}%;height:100%;border-radius:8px;min-width:3px;"></div>
      </div>
    </td>
    <td style="padding:3px 0 3px 10px;font-size:11px;color:${C.gray};white-space:nowrap;text-align:right;">
      ${human(count)}
    </td>
  </tr>`;
}

function summaryCard(value, label, accentColor) {
  return `<td style="padding:0 6px 0 0;">
    <div style="background:#fff;border-left:4px solid ${accentColor};border-radius:3px;
                padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.07);">
      <div style="font-size:22px;font-weight:700;color:${accentColor};line-height:1;">${value}</div>
      <div style="font-size:9.5px;color:${C.grayLight};text-transform:uppercase;
                  letter-spacing:0.5px;margin-top:5px;">${label}</div>
    </div>
  </td>`;
}

/**
 * SVG donut chart with a colour-coded legend table beside it.
 * Used for Web Traffic by Country.
 */
function countryPieChart(byCountry, httpVisits) {
  const items = byCountry.slice(0, 10);
  if (!items.length) return '';

  const countTotal   = items.reduce((s, r) => s + r.count, 0);
  const displayTotal = httpVisits > 0 ? httpVisits : countTotal;

  // SVG donut using stroke-dasharray trick (starts at 12 o'clock)
  const R = 55, CX = 70, CY = 70, SW = 22;
  const circ = 2 * Math.PI * R;
  let cum = 0;

  const circles = items.map((item, i) => {
    const frac   = countTotal > 0 ? item.count / countTotal : 0;
    const dash   = frac * circ;
    const offset = circ / 4 - cum;
    cum += dash;
    return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${PIE_COLORS[i % PIE_COLORS.length]}" ` +
      `stroke-width="${SW}" ` +
      `stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" ` +
      `stroke-dashoffset="${offset.toFixed(1)}"/>`;
  }).join('');

  const svg = `<svg width="140" height="140" viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg">
    ${circles}
    <circle cx="${CX}" cy="${CY}" r="${R - SW / 2 - 2}" fill="white"/>
    <text x="${CX}" y="${CY - 4}" text-anchor="middle" font-family="Arial,sans-serif"
          font-size="15" font-weight="700" fill="${C.burgundy}">${human(displayTotal)}</text>
    <text x="${CX}" y="${CY + 13}" text-anchor="middle" font-family="Arial,sans-serif"
          font-size="9" fill="${C.grayLight}">visits</text>
  </svg>`;

  const legendRows = items.map((item, i) => {
    const country = item.dimensions.clientCountryName || 'Unknown';
    const pct     = countTotal > 0 ? ((item.count / countTotal) * 100).toFixed(1) : '0';
    return `<tr>
      <td style="padding:3px 6px 3px 0;vertical-align:middle;">
        <div style="width:10px;height:10px;border-radius:2px;background:${PIE_COLORS[i % PIE_COLORS.length]};"></div>
      </td>
      <td style="font-size:11px;color:${C.nearBlack};padding:3px 16px 3px 2px;white-space:nowrap;">${country}</td>
      <td style="font-size:11px;color:${C.grayLight};padding:3px 0;text-align:right;">${pct}%</td>
      <td style="font-size:11px;color:${C.gray};padding:3px 0 3px 10px;text-align:right;font-weight:600;">${human(item.count)}</td>
    </tr>`;
  }).join('');

  return `<table cellpadding="0" cellspacing="0">
    <tr>
      <td valign="middle">${svg}</td>
      <td valign="middle" style="padding-left:24px;">
        <table cellpadding="0" cellspacing="0">${legendRows}</table>
      </td>
    </tr>
  </table>`;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function computeMetrics(analytics, httpSecurity) {
  const byDate = analytics.byDate  ?? [];
  const byCode = analytics.byResponseCode ?? [];

  const total   = byDate.reduce((s, d) => s + d.count, 0);
  const codeMap = Object.fromEntries(byCode.map(d => [d.dimensions.responseCode, d.count]));

  const noerror   = codeMap['NOERROR']  ?? 0;
  const nxdomain  = codeMap['NXDOMAIN'] ?? 0;
  const httpVisits = httpSecurity?.httpTotals?.[0]?.sum?.visits ?? 0;
  const bandwidth  = httpSecurity?.httpTotals?.[0]?.sum?.edgeResponseBytes ?? 0;

  return {
    total,
    noerror,
    nxdomain,
    successPct:  total > 0 ? ((noerror  / total) * 100).toFixed(1)  : '0.0',
    nxdomainPct: total > 0 ? ((nxdomain / total) * 100).toFixed(2) : '0.00',
    httpVisits,
    bandwidth,
  };
}

const SEC_ACTION_COLORS = {
  block:             C.red,
  managed_challenge: C.amber,
  challenge:         C.amber,
  jschallenge:       C.amber,
  log:               C.blue,
  allow:             C.green,
};

const SEC_ACTION_LABELS = {
  block:             'Blocked',
  managed_challenge: 'Challenged (Turnstile)',
  challenge:         'CAPTCHA Challenge',
  jschallenge:       'JS Challenge',
  log:               'Logged / Monitored',
  allow:             'Explicitly Allowed',
  bypass:            'Rule Bypass',
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render the full HTML email report.
 *
 * @param {object} opts
 * @param {string}   opts.reportTitle
 * @param {string}   opts.zoneName
 * @param {string}   opts.frequency      - 'daily' | 'weekly' | 'monthly'
 * @param {object}   opts.period         - { start, end }
 * @param {object}   opts.analytics      - DNS analytics from collectReportData()
 * @param {Array}    opts.dnsRecords
 * @param {object}   opts.dnssec
 * @param {object}   opts.httpSecurity   - { byCountry, httpTotals, securityByAction }
 * @param {object}   opts.aiTraffic      - { rows: [{name,count,bytes}], byDay: [{date,count}] }
 * @param {object}   opts.gateway        - { gwDnsByDecision, gwDnsTopDomains, gwHttpByAction, gwTopBandwidth }
 * @param {boolean}  opts.reportDns      - show DNS analytics sections
 * @param {boolean}  opts.reportZtna     - show Gateway/ZTNA section
 * @param {string}   opts.generatedAt
 */
export function renderEmail({
  reportTitle,
  zoneName,
  frequency,
  period,
  analytics,
  dnsRecords,
  dnssec,
  httpSecurity = {},
  aiTraffic    = {},
  gateway      = {},
  reportDns    = true,
  reportZtna   = true,
  generatedAt,
}) {
  const freq = frequency.charAt(0).toUpperCase() + frequency.slice(1);
  const m    = computeMetrics(analytics, httpSecurity);

  // ── DNS query volume by day (mini bar chart) ───────────────────────────────
  const byDate = analytics.byDate ?? [];
  const maxDay = Math.max(...byDate.map(d => d.count), 1);
  const dayBars = byDate.map(d => {
    const pct = Math.max(Math.round((d.count / maxDay) * 100), 2);
    const dt  = d.dimensions.date.slice(5);
    return `<td style="text-align:center;vertical-align:bottom;padding:0 2px;">
      <div style="background:${C.burgundy};height:${Math.max(pct * 0.65, 3)}px;
                  border-radius:2px 2px 0 0;opacity:0.85;min-width:8px;"></div>
      <div style="font-size:8px;color:${C.grayLight};margin-top:2px;">${dt}</div>
    </td>`;
  }).join('');

  // ── Top queried domains (filtered to A/AAAA/Tunnel in graphql layer) ───────
  const topNames   = analytics.byQueryName ?? [];
  const maxNames   = topNames[0]?.count ?? 1;
  const domainBars = topNames.slice(0, 12)
    .map(d => barRow(d.dimensions.queryName, d.count, maxNames, C.blue)).join('');

  // ── Connection success over time ───────────────────────────────────────────
  const byCodeByDate = analytics.byResponseCodeByDate ?? [];
  const daySuccess   = {};
  for (const row of byCodeByDate) {
    const { date, responseCode } = row.dimensions;
    if (!daySuccess[date]) daySuccess[date] = { success: 0, fail: 0, total: 0 };
    daySuccess[date].total += row.count;
    if (responseCode === 'NOERROR') daySuccess[date].success += row.count;
    else                            daySuccess[date].fail    += row.count;
  }
  const daySuccessSorted = Object.entries(daySuccess).sort(([a], [b]) => a.localeCompare(b));
  const maxDayTotal      = Math.max(...daySuccessSorted.map(([, d]) => d.total), 1);
  const periodSuccess    = daySuccessSorted.reduce((s, [, d]) => s + d.success, 0);
  const periodFail       = daySuccessSorted.reduce((s, [, d]) => s + d.fail, 0);
  const periodTotal      = periodSuccess + periodFail;
  const periodSuccessPct = periodTotal > 0 ? ((periodSuccess / periodTotal) * 100).toFixed(1) : '0';

  const successBars = daySuccessSorted.map(([date, d]) => {
    const pct    = d.total > 0 ? d.success / d.total : 0;
    const height = Math.max(Math.round((d.total / maxDayTotal) * 65), 3);
    const color  = pct >= 0.99 ? C.green : pct >= 0.95 ? C.amber : C.red;
    const dt     = date.slice(5);
    return `<td style="text-align:center;vertical-align:bottom;padding:0 2px;">
      <div style="background:${color};height:${height}px;border-radius:2px 2px 0 0;min-width:8px;opacity:0.9;"></div>
      <div style="font-size:8px;color:${C.grayLight};margin-top:2px;">${dt}</div>
    </td>`;
  }).join('');

  // ── Traffic by country (pie chart) ────────────────────────────────────────
  const byCountry    = httpSecurity.byCountry ?? [];
  const countryChart = byCountry.length ? countryPieChart(byCountry, m.httpVisits) : '';

  // ── Security events ────────────────────────────────────────────────────────
  const secActions = (httpSecurity.securityByAction ?? []).filter(r => r.count > 0);
  const maxSec     = secActions[0]?.count ?? 1;
  const secBars    = secActions.slice(0, 8).map(r => {
    const action = r.dimensions?.action ?? '';
    const label  = SEC_ACTION_LABELS[action] ?? action;
    const color  = SEC_ACTION_COLORS[action]  ?? C.gray;
    return barRow(label, r.count, maxSec, color);
  }).join('');

  // ── AI crawlers ────────────────────────────────────────────────────────────
  const aiRows   = (aiTraffic.rows  ?? []).slice(0, 8);
  const aiByDay  =  aiTraffic.byDay ?? [];
  const maxAi    = aiRows[0]?.count ?? 1;
  const aiBars   = aiRows.map(r => barRow(r.name, r.count, maxAi, C.purple)).join('');

  const maxAiDay  = Math.max(...aiByDay.map(d => d.count), 1);
  const aiDayBars = aiByDay.map(d => {
    const pct = Math.max(Math.round((d.count / maxAiDay) * 100), 2);
    const dt  = d.date.slice(5);
    return `<td style="text-align:center;vertical-align:bottom;padding:0 2px;">
      <div style="background:${C.purple};height:${Math.max(pct * 0.60, 3)}px;
                  border-radius:2px 2px 0 0;opacity:0.85;min-width:8px;"></div>
      <div style="font-size:8px;color:${C.grayLight};margin-top:2px;">${dt}</div>
    </td>`;
  }).join('');

  // ── Gateway / ZTNA ────────────────────────────────────────────────────────
  const gwDecisions   = gateway.gwDnsByDecision  ?? [];
  const gwTopDomains  = gateway.gwDnsTopDomains  ?? [];
  const gwHttpActions = gateway.gwHttpByAction   ?? [];
  const hasGateway    = gwDecisions.length > 0 || gwHttpActions.length > 0 || gwTopDomains.length > 0;

  const maxGwDec  = gwDecisions[0]?.count ?? 1;
  const gwDecBars = gwDecisions.slice(0, 8).map(r => {
    const d = String(r.dimensions.resolverDecision ?? '').toLowerCase();
    const color = d.includes('allow') ? C.green : d.includes('block') ? C.red : C.amber;
    return barRow(String(r.dimensions.resolverDecision ?? ''), r.count, maxGwDec, color);
  }).join('');

  const maxGwAct  = gwHttpActions[0]?.count ?? 1;
  const gwActBars = gwHttpActions.slice(0, 6).map(r => {
    const action = r.dimensions.action ?? '';
    const color  = { allow: C.green, block: C.red, isolate: C.amber }[action] ?? C.gray;
    return barRow(action, r.count, maxGwAct, color);
  }).join('');

  const maxGwDom  = gwTopDomains[0]?.count ?? 1;
  const gwDomBars = gwTopDomains.slice(0, 10).map(r => {
    const domain = (r.dimensions.queryNameReversed ?? '').split('.').reverse().join('.');
    return barRow(domain, r.count, maxGwDom, C.purple);
  }).join('');

  // ── DNS config summary ─────────────────────────────────────────────────────
  const proxied = dnsRecords.filter(r => r.proxied).length;

  // ── DNSSEC ─────────────────────────────────────────────────────────────────
  const dsStatus = (dnssec?.status ?? 'unknown').toLowerCase();
  const dsColor  = dsStatus === 'active' ? C.green
                 : dsStatus === 'unknown' ? C.amber : C.red;
  const dsLabel  = dsStatus === 'active'
    ? 'Active — DNS responses are cryptographically signed, protecting visitors from DNS hijacking.'
    : dsStatus === 'disabled' || dsStatus === 'inactive'
    ? 'Not enabled — enabling DNSSEC is recommended to protect visitors from being redirected to fake sites.'
    : `Status: ${dnssec?.status ?? 'unknown'}`;

  // ── Summary cards ─────────────────────────────────────────────────────────
  const hasHttp = m.httpVisits > 0 || byCountry.length > 0;
  const card4   = hasHttp
    ? summaryCard(human(m.httpVisits), 'HTTP Visits', C.blue)
    : summaryCard(String(dnsRecords.length), 'DNS Records', C.blue);

  const blockedCount = secActions
    .filter(r => ['block','managed_challenge','challenge','jschallenge']
      .includes(r.dimensions?.action ?? ''))
    .reduce((s, r) => s + r.count, 0);

  // ── Compose email ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${reportTitle} — ${freq} Report</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:24px 12px;">
<table width="700" cellpadding="0" cellspacing="0"
       style="max-width:700px;width:100%;background:#fff;border-radius:6px;
              box-shadow:0 2px 12px rgba(0,0,0,.10);overflow:hidden;">

  <!-- HEADER ─────────────────────────────────────────────────── -->
  <tr>
    <td style="background:${C.burgundy};padding:28px 32px;">
      <div style="font-size:9px;text-transform:uppercase;letter-spacing:2px;
                  color:rgba(255,255,255,.6);margin-bottom:6px;">Cloudflare Website &amp; DNS Report</div>
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#fff;">${reportTitle}</h1>
      <div style="margin-top:8px;font-size:12px;color:rgba(255,255,255,.8);">
        &#9656; ${zoneName} &nbsp;&#9656; ${freq} Report &nbsp;&#9656; ${period.start} — ${period.end}
      </div>
      <div style="display:inline-block;margin-top:12px;background:rgba(255,255,255,.18);
                  border:1px solid rgba(255,255,255,.35);border-radius:12px;padding:3px 12px;
                  font-size:9px;font-weight:700;letter-spacing:1px;
                  color:#fff;text-transform:uppercase;">${freq}</div>
    </td>
  </tr>
  <tr>
    <td style="background:${C.burgundyDark};padding:7px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:11px;color:rgba(255,255,255,.7);">${period.start} to ${period.end}</td>
        <td style="font-size:11px;color:rgba(255,255,255,.7);text-align:right;">${generatedAt}</td>
      </tr></table>
    </td>
  </tr>

  ${reportDns ? `
  <!-- SUMMARY CARDS ────────────────────────────────────────────── -->
  <tr>
    <td style="background:${C.bgLight};padding:18px 32px;border-bottom:1px solid ${C.border};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        ${summaryCard(human(m.total),      'DNS Lookups',    C.burgundy)}
        ${summaryCard(m.successPct + '%',  'Success Rate',   C.green)}
        ${blockedCount > 0
          ? summaryCard(human(blockedCount), 'Threats Blocked', C.red)
          : summaryCard(m.nxdomainPct + '%', 'NXDOMAIN Rate',   parseFloat(m.nxdomainPct) > 5 ? C.amber : C.nearBlack)}
        ${card4}
      </tr></table>
    </td>
  </tr>

  <!-- SECTION BANNER: WEBSITE & DNS ───────────────────────────── -->
  <tr>
    <td style="background:${C.burgundy};padding:10px 32px;">
      <span style="font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;
                   letter-spacing:1px;">Website &amp; DNS Analytics</span>
      <span style="font-size:10px;color:rgba(255,255,255,.7);margin-left:8px;">
        Traffic, performance, and security for ${zoneName}
      </span>
    </td>
  </tr>` : ''}

  ${reportDns && byDate.length ? `
  <!-- QUERY VOLUME BY DAY ─────────────────────────────────────── -->
  ${sectionTitle('DNS Activity Over Time')}
  <tr><td style="padding:0 32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="vertical-align:bottom;height:80px;">${dayBars}</tr>
    </table>
  </td></tr>` : ''}

  ${reportDns && domainBars ? `
  <!-- TOP QUERIED DOMAINS ─────────────────────────────────────── -->
  ${sectionTitle('Most Active Services &amp; Domains')}
  <tr><td style="padding:0 32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0">${domainBars}</table>
  </td></tr>` : ''}

  ${reportDns && countryChart ? `
  <!-- TRAFFIC BY COUNTRY ──────────────────────────────────────── -->
  ${sectionTitle('Web Traffic by Country')}
  <tr><td style="padding:0 32px 16px;">
    ${m.bandwidth > 0 ? `<div style="font-size:11px;color:${C.gray};margin-bottom:12px;">
      Bandwidth: <strong>${humanBytes(m.bandwidth)}</strong>
    </div>` : ''}
    ${countryChart}
  </td></tr>` : ''}

  ${reportDns && daySuccessSorted.length ? `
  <!-- CONNECTION SUCCESS OVER TIME ────────────────────────────── -->
  ${sectionTitle('Connection Success Over Time')}
  <tr><td style="padding:0 32px 6px;">
    <div style="font-size:11px;color:${C.gray};margin-bottom:8px;">
      <span style="color:${C.green};font-weight:700;">&#9632;</span> &gt;99% success &nbsp;&nbsp;
      <span style="color:${C.amber};font-weight:700;">&#9632;</span> 95–99% &nbsp;&nbsp;
      <span style="color:${C.red};font-weight:700;">&#9632;</span> &lt;95%
      &nbsp;&nbsp;|&nbsp;&nbsp;
      Period: <strong>${periodSuccessPct}%</strong> successful
      ${periodFail > 0 ? `(${human(periodFail)} failed of ${human(periodTotal)})` : ''}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="vertical-align:bottom;height:75px;">${successBars}</tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 12px;"></td></tr>` : ''}

  ${reportDns && secBars ? `
  <!-- SECURITY EVENTS ─────────────────────────────────────────── -->
  ${sectionTitle('Security Events')}
  <tr><td style="padding:0 32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0">${secBars}</table>
  </td></tr>` : ''}

  ${reportDns && (aiBars || aiDayBars) ? `
  <!-- AI CRAWLER ACTIVITY ─────────────────────────────────────── -->
  ${sectionTitle('AI Crawler Activity')}
  <tr><td style="padding:0 32px 6px;">
    <div style="font-size:11px;color:${C.gray};margin-bottom:10px;">
      Known AI companies crawling this website, detected by user-agent signature.
      Use Cloudflare AI Crawl Control to allow or block specific crawlers.
    </div>
    ${aiDayBars ? `
    <div style="font-size:10px;font-weight:600;color:${C.gray};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.4px;">Total AI Traffic by Day</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
      <tr style="vertical-align:bottom;height:60px;">${aiDayBars}</tr>
    </table>` : ''}
    ${aiBars ? `
    <div style="font-size:10px;font-weight:600;color:${C.gray};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.4px;">Activity by Crawler</div>
    <table width="100%" cellpadding="0" cellspacing="0">${aiBars}</table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;">
      ${aiRows.map(r => `<tr>
        <td style="font-size:11px;color:${C.nearBlack};padding:2px 10px 2px 0;
                   font-family:monospace;">${r.name}</td>
        <td style="font-size:11px;color:${C.gray};">${humanBytes(r.bytes)}</td>
      </tr>`).join('')}
    </table>` : ''}
  </td></tr>
  <tr><td style="padding:0 32px 16px;"></td></tr>` : ''}

  ${reportDns ? `
  <!-- DNSSEC STATUS ───────────────────────────────────────────── -->
  ${sectionTitle('DNS Security (DNSSEC)')}
  <tr><td style="padding:0 32px 16px;">
    <div style="border:1px solid ${C.border};border-radius:4px;padding:14px 18px;background:${C.bgLight};">
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:12px;vertical-align:top;padding-top:2px;">
          <div style="width:12px;height:12px;border-radius:50%;background:${dsColor};"></div>
        </td>
        <td>
          <div style="font-size:12px;font-weight:600;margin-bottom:3px;">
            ${dsStatus === 'active' ? 'DNS Tampering Protection: Active'
              : dsStatus === 'disabled' || dsStatus === 'inactive' ? 'DNS Tampering Protection: Not Enabled'
              : `DNSSEC: ${dnssec?.status ?? 'Unknown'}`}
          </div>
          <div style="font-size:11px;color:${C.gray};">${dsLabel}</div>
        </td>
      </tr></table>
    </div>
  </td></tr>

  <!-- DNS CONFIGURATION SUMMARY ───────────────────────────────── -->
  ${sectionTitle('DNS Configuration')}
  <tr><td style="padding:0 32px 16px;">
    <div style="border:1px solid ${C.border};border-radius:4px;padding:14px 18px;
                background:${C.bgLight};font-size:12px;color:${C.gray};line-height:1.7;">
      <strong style="color:${C.nearBlack};">${dnsRecords.length}</strong> DNS records configured.
      ${proxied > 0
        ? `<strong style="color:${C.burgundy};">${proxied}</strong> record${proxied !== 1 ? 's' : ''} routed through Cloudflare's network for added performance and protection.`
        : 'No records are currently proxied through Cloudflare.'}
    </div>
  </td></tr>` : ''}

  ${reportZtna && hasGateway ? `
  <!-- SECTION BANNER: GATEWAY / ZTNA ─────────────────────────── -->
  <tr>
    <td style="background:#1a3a5c;padding:10px 32px;margin-top:8px;">
      <span style="font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:1px;">
        Cloudflare Gateway &amp; Zero Trust
      </span>
      <span style="font-size:10px;color:rgba(255,255,255,.7);margin-left:8px;">
        Network security, DNS filtering, and access control
      </span>
    </td>
  </tr>

  ${gwDecBars ? `
  <tr><td style="padding:22px 32px 10px;">
    <div style="font-size:11px;font-weight:700;color:#1a3a5c;text-transform:uppercase;
                letter-spacing:.6px;border-bottom:2px solid #1a3a5c;padding-bottom:5px;margin-bottom:10px;">
      Gateway DNS Filtering
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">${gwDecBars}</table>
  </td></tr>` : ''}

  ${gwDomBars ? `
  <tr><td style="padding:0 32px 16px;">
    <div style="font-size:11px;font-weight:600;color:${C.nearBlack};margin-bottom:6px;">Top Queried Domains</div>
    <table width="100%" cellpadding="0" cellspacing="0">${gwDomBars}</table>
  </td></tr>` : ''}

  ${gwActBars ? `
  <tr><td style="padding:0 32px 16px;">
    <div style="font-size:11px;font-weight:700;color:#1a3a5c;text-transform:uppercase;
                letter-spacing:.6px;border-bottom:2px solid #1a3a5c;padding-bottom:5px;margin-bottom:10px;">
      Proxy Traffic Actions
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">${gwActBars}</table>
  </td></tr>` : ''}

  ` : ''}

  <!-- FOOTER ──────────────────────────────────────────────────── -->
  <tr>
    <td style="padding:18px 32px;border-top:2px solid ${C.border};margin-top:12px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:10px;color:${C.grayLight};">
          ${zoneName} &bull; ${freq} Report &bull; ${period.start} – ${period.end}
        </td>
        <td style="text-align:right;font-size:10px;color:${C.grayLight};">
          CloudflareDNS-Auto-Report
        </td>
      </tr></table>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
