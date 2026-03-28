/**
 * Report builder: orchestrates data collection → rendering → email delivery.
 *
 * Reads all active report_configs for a frequency from D1, decrypts stored
 * API tokens, calls collectReportData(), renders HTML, and sends via Resend.
 */

import { CloudflareClient } from './cloudflare-graphql.js';
import { renderEmail }       from '../templates/email-template.js';
import { sendReportEmail }   from './email-sender.js';
import { decryptToken }      from './crypto.js';

/**
 * Process all enabled report configs for the given frequency.
 * Called from the scheduled handler — runs sequentially to avoid rate limits.
 *
 * @param {string} frequency - 'daily' | 'weekly' | 'monthly'
 * @param {object} env       - Worker env (DB, secrets)
 */
export async function processReports(frequency, env) {
  const today = new Date().toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(`
    SELECT rc.id, rc.label, rc.zone_id, rc.zone_name, rc.frequency,
           rc.recipients, rc.subject_prefix, rc.report_title,
           rc.start_date, rc.end_date,
           c.encrypted_token
    FROM report_configs rc
    JOIN credentials c ON c.id = rc.credential_id
    WHERE rc.frequency  = ?
      AND rc.enabled    = 1
      AND rc.start_date <= ?
      AND (rc.end_date IS NULL OR rc.end_date >= ?)
  `).bind(frequency, today, today).all();

  if (!results?.length) {
    console.log(`[${frequency}] No active report configs — nothing to do.`);
    return;
  }

  console.log(`[${frequency}] Processing ${results.length} config(s)`);

  for (const config of results) {
    await _processOne(config, frequency, env);
  }
}

async function _processOne(config, frequency, env) {
  const label = config.label ?? config.zone_name;

  // ── Decrypt API token ──────────────────────────────────────────────────────
  let apiToken;
  try {
    if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY secret is not set');
    apiToken = await decryptToken(config.encrypted_token, env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    console.error(`[${label}] Token decrypt failed: ${err.message}`);
    await _recordRun(env, config.id, config.zone_name, frequency, '?', '?', 'failed',
      `Token decrypt error: ${err.message}`);
    return;
  }

  // ── Collect all report data ────────────────────────────────────────────────
  const client = new CloudflareClient(apiToken);
  let reportData;
  try {
    reportData = await client.collectReportData(config.zone_id, frequency);
  } catch (err) {
    console.error(`[${label}] Data collection failed: ${err.message}`);
    await _recordRun(env, config.id, config.zone_name, frequency, '?', '?', 'failed',
      `Data collection: ${err.message}`);
    return;
  }

  const { period } = reportData;

  // ── Render HTML email ──────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const html = renderEmail({
    reportTitle:  config.report_title || config.label,
    zoneName:     config.zone_name,
    frequency,
    period,
    analytics:    reportData.analytics,
    dnsRecords:   reportData.dnsRecords,
    dnssec:       reportData.dnssec,
    httpSecurity: reportData.http_security  ?? {},
    aiTraffic:    reportData.ai_traffic     ?? [],
    gateway:      reportData.gateway        ?? {},
    generatedAt,
  });

  // ── Send email ─────────────────────────────────────────────────────────────
  let recipients;
  try { recipients = JSON.parse(config.recipients); } catch { recipients = [config.recipients]; }

  if (!recipients.length) {
    console.warn(`[${label}] No recipients — skipping.`);
    return;
  }

  const freq    = frequency.charAt(0).toUpperCase() + frequency.slice(1);
  const prefix  = config.subject_prefix || '[DNS Report]';
  const subject = `${prefix} ${freq} Report — ${config.zone_name} (${period.start} to ${period.end})`;

  try {
    await sendReportEmail(env, recipients, subject, html);
    console.log(`[${label}] Sent to ${recipients.join(', ')}`);
    await _recordRun(env, config.id, config.zone_name, frequency,
      period.start, period.end, 'sent', null);
  } catch (err) {
    console.error(`[${label}] Email delivery failed: ${err.message}`);
    await _recordRun(env, config.id, config.zone_name, frequency,
      period.start, period.end, 'failed', err.message);
  }
}

async function _recordRun(env, configId, zoneName, frequency, periodStart, periodEnd, status, errorMsg) {
  try {
    await env.DB.prepare(`
      INSERT INTO report_runs
        (report_config_id, zone_name, frequency, period_start, period_end, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(configId, zoneName, frequency, periodStart, periodEnd, status, errorMsg ?? null).run();
  } catch (err) {
    console.error(`Failed to record run for config ${configId}: ${err.message}`);
  }
}
