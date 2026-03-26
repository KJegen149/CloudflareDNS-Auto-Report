/**
 * Cloudflare DNS Auto-Report — Worker entry point.
 *
 * Three cron triggers fire at 08:00 UTC:
 *   0 8 * * *   → daily
 *   0 8 * * 1   → weekly
 *   0 8 1 * *   → monthly
 *
 * On each trigger the worker loads account configs from KV, filters to those
 * whose schedule.frequency matches the fired cron, and generates reports.
 *
 * Account config is stored in Workers KV under the key "accounts_config".
 * Secrets (API tokens, email keys) are Workers Secrets accessed via env.
 *
 * ── First-time setup ───────────────────────────────────────────────────────
 * 1. Create KV namespace:
 *      npx wrangler kv namespace create DNS_REPORT_CONFIG
 *    Update wrangler.toml with the returned ID.
 *
 * 2. Upload your accounts config to KV:
 *      npx wrangler kv key put --namespace-id=<id> accounts_config \
 *        "$(cat config/accounts.workers.json)"
 *    (accounts.workers.json is the same as accounts.json but WITHOUT smtp_profiles,
 *    since Workers uses Resend instead of SMTP)
 *
 * 3. Set secrets:
 *      npx wrangler secret put CF_TOKEN_APPLE_JUICE
 *      npx wrangler secret put CF_TOKEN_ORANGE_JUICE
 *      npx wrangler secret put RESEND_API_KEY
 *      npx wrangler secret put EMAIL_FROM_ADDRESS
 *      npx wrangler secret put EMAIL_FROM_NAME
 *
 * 4. Deploy:
 *      npm run deploy
 *
 * ── Local testing ──────────────────────────────────────────────────────────
 *   npm run dev          # starts wrangler dev with --test-scheduled
 *   npm run test-daily   # triggers the daily cron
 *   npm run test-weekly  # triggers the weekly cron
 *   npm run test-monthly # triggers the monthly cron
 */

import { processAccount } from './lib/report-builder.js';

/** Map cron expressions to frequency strings. */
const CRON_TO_FREQUENCY = {
  '0 * * * *': 'hourly',   // testing only — remove in production
  '0 8 * * *': 'daily',
  '0 8 * * 1': 'weekly',
  '0 8 1 * *': 'monthly',
};

export default {
  /**
   * Scheduled handler — called by Cloudflare's cron infrastructure.
   * @param {ScheduledController} controller
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    const cron      = controller.cron;
    const frequency = CRON_TO_FREQUENCY[cron];

    if (!frequency) {
      console.warn(`Unknown cron pattern '${cron}' — no frequency mapping found.`);
      return;
    }

    console.log(`Cron fired: '${cron}' → frequency: ${frequency}`);

    // Load account configs from KV
    const configJson = await env.DNS_REPORT_CONFIG.get('accounts_config');
    if (!configJson) {
      console.error("No 'accounts_config' key found in DNS_REPORT_CONFIG KV namespace.");
      return;
    }

    let config;
    try {
      config = JSON.parse(configJson);
    } catch (err) {
      console.error(`Failed to parse accounts_config JSON: ${err.message}`);
      return;
    }

    const accounts = (config.accounts ?? []).filter(
      a => (a.schedule?.frequency ?? '').toLowerCase() === frequency
    );

    if (!accounts.length) {
      console.log(`No accounts configured for frequency '${frequency}' — nothing to do.`);
      return;
    }

    console.log(`Processing ${accounts.length} account(s) for frequency '${frequency}'`);

    // Process each matching account (sequential to avoid rate limits)
    for (const account of accounts) {
      ctx.waitUntil(
        processAccount(account, env, frequency).catch(err => {
          console.error(`Failed processing account '${account.id}': ${err.message}`);
        })
      );
    }
  },

  /**
   * HTTP handler — returns a simple status page.
   * (Workers require a fetch handler when using modules format.)
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'cloudflare-dns-auto-report' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Cloudflare DNS Auto-Report — scheduled worker', { status: 200 });
  },
};
