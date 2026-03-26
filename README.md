# CloudflareDNS-Auto-Report

Cloudflare generates fantastic DNS reporting but does not email out any comprehensive reports — only allows manual exports. This project fixes that.

Automatically generate PDF or rich HTML DNS analytics reports from the Cloudflare API and deliver them to one or more email addresses on a **daily, weekly, or monthly** schedule. Supports multiple Cloudflare accounts and zones, each with independent schedules and recipient lists.

---

## What's in Each Report

| Section | Data Source |
|---|---|
| Total query volume (+ trend by day) | GraphQL `dnsAnalyticsAdaptiveGroups` |
| Top 15 queried domain names | GraphQL `dnsAnalyticsAdaptiveGroups` |
| Record type distribution (A, AAAA, MX, CNAME…) | GraphQL `dnsAnalyticsAdaptiveGroups` |
| Response code analysis (NOERROR, NXDOMAIN, SERVFAIL…) | GraphQL `dnsAnalyticsAdaptiveGroups` |
| Cache hit rate | GraphQL `dnsAnalyticsAdaptiveGroups` |
| Full DNS record inventory | REST `/zones/{id}/dns_records` |
| DNSSEC status | REST `/zones/{id}/dnssec` |

---

## Two Deployment Options

| | Heroku / Python | Cloudflare Workers |
|---|---|---|
| **Scheduling** | APScheduler (cron) | Workers Cron Triggers |
| **Report format** | **PDF** (WeasyPrint) attached to email | Rich **HTML email** |
| **Email delivery** | Direct SMTP | [Resend](https://resend.com) HTTP API |
| **Config secrets** | `.env` file | Workers Secrets (`wrangler secret put`) |
| **Best for** | PDF attachments, own infrastructure | Serverless, zero-maintenance |

---

## Quick Start — Heroku / Python (PDF via SMTP)

### Prerequisites
- Python 3.11+
- A Cloudflare API token with: `Zone.DNS:Read`, `Zone.Zone:Read`, `Zone.Analytics:Read`
- SMTP credentials

### 1. Clone and install

```bash
git clone https://github.com/kjegen149/cloudflaredns-auto-report.git
cd cloudflaredns-auto-report/heroku
pip install -r requirements.txt
```

### 2. Configure accounts

```bash
cp ../config/accounts.example.json ../config/accounts.json
# Edit accounts.json — add your zone IDs, schedules, and recipient emails
```

### 3. Set environment variables

```bash
cp .env.example .env
# Edit .env — add your CF API tokens and SMTP credentials
```

### 4. Test immediately

```bash
python -m src.main --run-now all
```

This generates and emails reports for all configured accounts right now.

### 5. Start the scheduler daemon

```bash
python -m src.main
```

Or on Heroku:
```bash
heroku ps:scale worker=1
```

---

## Quick Start — Cloudflare Workers (HTML email via Resend)

### Prerequisites
- [Node.js](https://nodejs.org/) + npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- A Cloudflare account (Workers free tier is sufficient)
- A [Resend](https://resend.com) account (free tier: 3,000 emails/month)

### 1. Install dependencies

```bash
cd workers
npm install
```

### 2. Create a KV namespace

```bash
npx wrangler kv namespace create DNS_REPORT_CONFIG
# Copy the ID into wrangler.toml → kv_namespaces[0].id

npx wrangler kv namespace create DNS_REPORT_CONFIG --preview
# Copy the preview ID into wrangler.toml → kv_namespaces[0].preview_id
```

### 3. Upload account config to KV

Create `config/accounts.workers.json` (same format as `accounts.example.json` but without `smtp_profiles` — Workers uses Resend instead):

```bash
npx wrangler kv key put \
  --namespace-id=YOUR_KV_NAMESPACE_ID \
  accounts_config \
  "$(cat ../config/accounts.workers.json)"
```

### 4. Set secrets

```bash
npx wrangler secret put CF_TOKEN_APPLE_JUICE   # one per account
npx wrangler secret put CF_TOKEN_ORANGE_JUICE
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM_ADDRESS      # e.g. reports@yourdomain.com
npx wrangler secret put EMAIL_FROM_NAME         # e.g. "Cloudflare DNS Reports"
```

### 5. Local development

```bash
# Copy .dev.vars.example to .dev.vars and fill in values
cp .dev.vars.example .dev.vars

npm run dev
# In another terminal:
npm run test-daily    # triggers the daily report
npm run test-weekly   # triggers the weekly report
npm run test-monthly  # triggers the monthly report
```

### 6. Deploy

```bash
npm run deploy
```

---

## Account Configuration Reference (`accounts.json`)

```jsonc
{
  "accounts": [
    {
      "id": "apple-juice",               // unique identifier (used in logs + CLI)
      "display_name": "Apple Juice Corp",
      "cloudflare_api_token_env": "CF_TOKEN_APPLE_JUICE",  // env var holding the token
      "cloudflare_account_id": "abc123",
      "zones": [
        { "zone_id": "xyz456", "zone_name": "applejuice.com" }
      ],
      "schedule": {
        "frequency": "monthly",  // "daily" | "weekly" | "monthly"
        "day_of_month": 1,       // for monthly: day of month to send (1 = 1st)
        "day_of_week": "monday", // for weekly: which day to send
        "hour_utc": 8,           // UTC hour to send (0–23)
        "minute_utc": 0
      },
      "email": {
        "smtp_profile": "default",
        "recipients": ["admin@applejuice.com"],
        "subject_prefix": "[DNS Report]"
      },
      "report": {
        "title": "Apple Juice Corp — DNS Report",
        "include_dns_records": true,
        "top_queries_limit": 15,
        "lookback_override_days": null  // override period (null = use frequency default)
      }
    }
  ],
  "smtp_profiles": {
    "default": {
      "host_env": "SMTP_HOST",
      "port_env": "SMTP_PORT",
      "username_env": "SMTP_USERNAME",
      "password_env": "SMTP_PASSWORD",
      "from_email_env": "SMTP_FROM_EMAIL",
      "from_name": "Cloudflare DNS Reports",
      "use_tls": true,
      "use_starttls": false
    }
  }
}
```

> **Security note:** All credential fields use the `*_env` naming convention — they reference the *name* of an environment variable, never the value itself. The actual secrets only live in `.env` (Heroku) or Workers Secrets (Workers deployment).

---

## Cloudflare API Token Setup

Create a scoped token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):

**Required permissions:**
| Permission | Level | Access |
|---|---|---|
| Zone — Analytics | Zone | Read |
| Zone — DNS | Zone | Read |
| Zone — Zone | Zone | Read |

**Zone Resources:** Include → Specific zone → (select your zone)

Create one token per Cloudflare account. If you have zones on the same account, one token can cover all of them.

---

## Postman Collection

Import `postman/Cloudflare-DNS-Reports.postman_collection.json` into Postman to explore the Cloudflare APIs directly.

Set up a Postman Environment with:
- `CF_API_TOKEN` — your API token
- `CF_ZONE_ID`   — zone ID from Cloudflare dashboard
- `CF_ACCOUNT_ID` — account ID
- `START_DATE`   — e.g. `2026-03-01`
- `END_DATE`     — e.g. `2026-03-25`

---

## Report Period Logic

| Frequency | Period Covered |
|---|---|
| `daily` | Yesterday (1 day) |
| `weekly` | Previous 7 days ending yesterday |
| `monthly` | Previous complete calendar month |

Override with `lookback_override_days` in the account config for a fixed window.

---

## Heroku Deployment

```bash
cd heroku
heroku create your-dns-reporter
heroku config:set CF_TOKEN_APPLE_JUICE=your_token ...
heroku config:set SMTP_HOST=smtp.example.com SMTP_PORT=465 ...
heroku config:set ACCOUNTS_CONFIG_PATH=config/accounts.json
git subtree push --prefix heroku heroku main
heroku ps:scale worker=1
```

---

## Project Structure

```
CloudflareDNS-Auto-Report/
├── config/
│   └── accounts.example.json   # Config template (copy to accounts.json)
├── heroku/                     # Python + WeasyPrint + SMTP deployment
│   ├── Procfile
│   ├── requirements.txt
│   ├── runtime.txt
│   ├── .env.example
│   ├── src/
│   │   ├── main.py             # Entry point + CLI
│   │   ├── config_loader.py    # Loads config, resolves env var secrets
│   │   ├── cloudflare_graphql.py  # Cloudflare API client
│   │   ├── report_generator.py    # Matplotlib charts + Jinja2 rendering
│   │   ├── pdf_generator.py       # HTML → PDF via WeasyPrint
│   │   ├── email_sender.py        # SMTP delivery
│   │   └── scheduler.py           # APScheduler cron setup
│   └── templates/
│       └── report.html.j2      # A4 print-ready PDF template
├── workers/                    # Cloudflare Workers + Resend deployment
│   ├── wrangler.toml
│   ├── package.json
│   ├── .dev.vars.example
│   └── src/
│       ├── index.js            # Worker entry + cron handler
│       └── lib/
│           ├── cloudflare-graphql.js  # CF API client (fetch-based)
│           ├── report-builder.js      # Orchestration
│           ├── email-sender.js        # Resend HTTP API
│           └── templates/
│               └── email-template.js  # HTML email renderer
└── postman/
    └── Cloudflare-DNS-Reports.postman_collection.json
```
