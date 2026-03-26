/**
 * Report builder: orchestrates data collection → template rendering
 * for a single account/zone in the Workers runtime.
 */
import { CloudflareClient } from './cloudflare-graphql.js';
import { renderEmail } from '../templates/email-template.js';
import { sendReportEmail } from './email-sender.js';

/**
 * Generate and send reports for all zones in one account.
 *
 * @param {object} account  - Resolved account config from KV.
 * @param {object} env      - Worker env (secrets + KV bindings).
 * @param {string} frequency - 'daily' | 'weekly' | 'monthly'
 */
export async function processAccount(account, env, frequency) {
  const apiToken = env[account.api_token_secret];
  if (!apiToken) {
    throw new Error(
      `Secret '${account.api_token_secret}' is not set for account '${account.id}'.`
    );
  }

  const client    = new CloudflareClient(apiToken);
  const lookback  = account.report?.lookback_override_days ?? null;
  const recipients = account.email?.recipients ?? [];

  if (!recipients.length) {
    console.warn(`[${account.id}] No recipients configured — skipping.`);
    return;
  }

  for (const zone of account.zones ?? []) {
    const zoneId   = zone.zone_id;
    const zoneName = zone.zone_name ?? zoneId;

    console.log(`[${account.id}] Generating ${frequency} report for ${zoneName}`);

    let reportData;
    try {
      reportData = await client.collectReportData(zoneId, frequency, lookback);
    } catch (err) {
      console.error(`[${account.id}] Data collection failed for ${zoneName}: ${err.message}`);
      continue;
    }

    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const reportTitle = account.report?.title ?? account.display_name ?? account.id;
    const freq        = frequency.charAt(0).toUpperCase() + frequency.slice(1);

    const html = renderEmail({
      accountName:  account.display_name ?? account.id,
      zoneName,
      frequency,
      period:       reportData.period,
      analytics:    reportData.analytics,
      dnsRecords:   reportData.dnsRecords,
      dnssec:       reportData.dnssec,
      reportTitle,
      generatedAt,
    });

    const prefix  = account.email?.subject_prefix ?? '[DNS Report]';
    const subject = `${prefix} ${freq} DNS Report — ${zoneName} (${reportData.period.start} to ${reportData.period.end})`;

    try {
      await sendReportEmail(env, recipients, subject, html);
      console.log(`[${account.id}] Report sent to ${recipients.join(', ')}`);
    } catch (err) {
      console.error(`[${account.id}] Email delivery failed for ${zoneName}: ${err.message}`);
    }
  }
}
