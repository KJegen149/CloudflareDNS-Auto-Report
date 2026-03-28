/**
 * Cloudflare DNS Auto-Report — Worker entry point.
 *
 * Cron triggers fire at 08:00 UTC on their respective schedules.
 * Each trigger loads matching report_configs from D1, checks start/end dates,
 * and sends reports via the Resend API.
 *
 * HTTP routes:
 *   GET  /health   → status JSON
 *   ANY  /admin/*  → Admin management UI (HTTP Basic Auth)
 *
 * ── First-time setup ───────────────────────────────────────────────────────
 * 1. Create D1 database:
 *      wrangler d1 create dns-reports
 *    Copy the database_id into wrangler.toml [[d1_databases]].
 *
 * 2. Apply schema:
 *      wrangler d1 execute dns-reports --file=workers/db/schema.sql
 *
 * 3. Set secrets:
 *      wrangler secret put RESEND_API_KEY
 *      wrangler secret put EMAIL_FROM_ADDRESS
 *      wrangler secret put EMAIL_FROM_NAME
 *      wrangler secret put ADMIN_PASSWORD
 *      wrangler secret put TOKEN_ENCRYPTION_KEY
 *    Generate TOKEN_ENCRYPTION_KEY:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * 4. Deploy:
 *      cd workers && npm run deploy
 *
 * 5. Open admin UI:
 *      https://cloudflare-dns-auto-report.<subdomain>.workers.dev/admin
 *    Add credentials (API token + account ID), then add report configs.
 */

import { processReports } from './lib/report-builder.js';
import { handleAdmin }    from './admin.js';

const CRON_TO_FREQUENCY = {
  '0 8 * * *': 'daily',
  '0 8 * * 1': 'weekly',
  '0 8 1 * *': 'monthly',
};

export default {
  /**
   * Scheduled handler — triggered by Cloudflare cron infrastructure.
   */
  async scheduled(controller, env, ctx) {
    const frequency = CRON_TO_FREQUENCY[controller.cron];

    if (!frequency) {
      console.warn(`Unknown cron pattern '${controller.cron}' — no frequency mapping found.`);
      return;
    }

    console.log(`Cron fired: '${controller.cron}' → frequency: ${frequency}`);

    ctx.waitUntil(
      processReports(frequency, env).catch(err => {
        console.error(`processReports('${frequency}') uncaught error: ${err.message}`);
      }),
    );
  },

  /**
   * HTTP handler — admin UI + health check.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'cloudflare-dns-auto-report' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.pathname.startsWith('/admin')) {
      return handleAdmin(request, env);
    }

    return new Response('Cloudflare DNS Auto-Report — use /admin to manage reports.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
