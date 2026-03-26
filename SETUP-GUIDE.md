# DNS Auto-Report — Step-by-Step Setup Guide

> **How to use this guide:** Work through each Phase in order. Complete every
> checkbox and confirm it works before moving to the next Phase. If anything
> doesn't work, stop and fix it before continuing — each Phase builds on the
> last.

---

## Before You Start — Install These Once

These are one-time installs. If you already have them, skip ahead.

| Tool | Why you need it | Download |
|---|---|---|
| **Postman Desktop** | Test API calls visually | postman.com/downloads |
| **Python 3.11+** | Generate local reports | python.org/downloads |
| **Node.js 18+** | Deploy to Cloudflare Workers | nodejs.org |
| **Git** | Version control | git-scm.com |

---

## Phase 1 — Confirm API Access with Postman
**Goal:** Prove you can talk to Cloudflare's API and get DNS data back.
**Time:** ~15 minutes

### Step 1.1 — Find your Cloudflare Zone ID

1. Log into **dash.cloudflare.com**
2. Click on the domain you want to report on
3. On the **Overview** page, scroll down on the right sidebar
4. You'll see **Zone ID** — copy it and save it somewhere (Notepad is fine)

> Your Zone ID looks like this: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`

### Step 1.2 — Find your Cloudflare Account ID

1. Still on **dash.cloudflare.com**
2. In the right sidebar, just below Zone ID, you'll see **Account ID** — copy it too

### Step 1.3 — Create a Cloudflare API Token

> **Important:** Create a new token specifically for this tool. Don't use your
> Global API Key — scoped tokens are safer because they can only do what you
> allow.

1. Go to **dash.cloudflare.com/profile/api-tokens**
2. Click **Create Token**
3. Click **Create Custom Token** (at the bottom)
4. Fill in:
   - **Token name:** `DNS-Auto-Report`
   - **Permissions** — add these three rows:
     | | | |
     |---|---|---|
     | Zone | Analytics | Read |
     | Zone | DNS | Read |
     | Zone | Zone | Read |
   - **Zone Resources:** Include → Specific zone → (select your domain)
5. Click **Continue to summary** → **Create Token**
6. **Copy the token immediately** — Cloudflare only shows it once!

> Your token looks like this: `abc123def456abc123def456abc123def456abc`

### Step 1.4 — Import the Postman Collection

1. Open **Postman**
2. Click **Import** (top left)
3. Select the file: `postman/Cloudflare-DNS-Reports.postman_collection.json`
4. Click **Import**

You should now see "Cloudflare DNS Auto-Report — API Explorer" in your Collections list.

### Step 1.5 — Set Up a Postman Environment

1. In Postman, click **Environments** (left sidebar)
2. Click **+** to create a new environment
3. Name it: `CF DNS Reports`
4. Add these variables:

| Variable | Value (fill yours in) |
|---|---|
| `CF_API_TOKEN` | Your token from Step 1.3 |
| `CF_ZONE_ID` | Your Zone ID from Step 1.1 |
| `CF_ACCOUNT_ID` | Your Account ID from Step 1.2 |
| `START_DATE` | First day of last month, e.g. `2026-02-01` |
| `END_DATE` | Last day of last month, e.g. `2026-02-28` |

5. Click **Save**
6. In the top-right dropdown in Postman, select **CF DNS Reports** as your active environment

### Step 1.6 — Test Your API Access

Run these requests in order. Each one should return a green `200 OK`.

**Test 1: Verify your token works**
- Open: `4. API Token Verification → Verify Token`
- Click **Send**
- ✅ You should see `"status": "active"` in the response

**Test 2: Get your zone info**
- Open: `1. Zone Info → Get Zone Details`
- Click **Send**
- ✅ You should see your domain name and zone details

**Test 3: Get your DNS records**
- Open: `2. DNS Records → List DNS Records`
- Click **Send**
- ✅ You should see a list of your DNS records (A, CNAME, MX, etc.)

**Test 4: Get DNS analytics**
- Open: `3. DNS Analytics (GraphQL) → Full Report Query`
- Click **Send**
- ✅ You should see data with `byDate`, `byQueryType`, `byResponseCode`, `byQueryName`

> **If you get zero results in analytics:** This is normal if the date range has
> no data. Try changing `START_DATE` to 7 days ago and `END_DATE` to yesterday.

**✅ Phase 1 Complete** when all 4 tests return data.

---

## Phase 2 — Generate a Local Report
**Goal:** Turn that raw API data into a beautiful, readable HTML/PDF report
saved on your computer. No email yet — just verify it looks right.
**Time:** ~15 minutes

### Step 2.1 — Get the code

```bash
# If you haven't cloned the repo yet:
git clone https://github.com/KJegen149/CloudflareDNS-Auto-Report.git
cd CloudflareDNS-Auto-Report
```

### Step 2.2 — Install Python dependencies

```bash
cd heroku
pip install -r requirements.txt
```

> WeasyPrint may take a few minutes to install — this is normal.

### Step 2.3 — Create your accounts config

```bash
# From the repo root:
cp config/accounts.example.json config/accounts.json
```

Now open `config/accounts.json` in any text editor and fill in:

```json
{
  "accounts": [
    {
      "id": "my-account",
      "display_name": "My Company",
      "cloudflare_api_token_env": "CF_TOKEN_MY_ACCOUNT",
      "cloudflare_account_id": "PASTE YOUR ACCOUNT ID HERE",
      "zones": [
        {
          "zone_id": "PASTE YOUR ZONE ID HERE",
          "zone_name": "yourdomain.com"
        }
      ],
      "schedule": {
        "frequency": "hourly"
      },
      "email": {
        "smtp_profile": "default",
        "recipients": ["kjeg@protonmail.com"]
      },
      "report": {
        "title": "My Company — DNS Report",
        "include_dns_records": true,
        "top_queries_limit": 15,
        "lookback_override_days": null
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

> Set `frequency` to `"hourly"` for now — makes testing much easier. You'll change
> it to `"daily"`, `"weekly"`, or `"monthly"` once everything is working.

### Step 2.4 — Create your .env file

```bash
cd heroku
cp .env.example .env
```

Open `heroku/.env` and fill in **only this section** for now (SMTP comes in Phase 3):

```
CF_TOKEN_MY_ACCOUNT=paste_your_api_token_here
```

> The name `CF_TOKEN_MY_ACCOUNT` must match exactly what you put in
> `cloudflare_api_token_env` in accounts.json.

### Step 2.5 — Generate a local preview report

```bash
# From the heroku/ directory:
python -m src.main --preview
```

This will:
1. Fetch live DNS data from your Cloudflare account
2. Generate a beautified HTML + PDF report
3. Save both files to a `reports/` folder
4. Automatically open the HTML file in your browser

**✅ Phase 2 Complete** when:
- A browser window opens with your report
- You can see DNS query charts and data
- The report covers the time period you'd expect

> **Tip:** Reports are saved as `reports/dns-report-yourdomain.com-hourly-YYYY-MM-DD.html`
> You can open them anytime in your browser.

> **If you see empty charts:** Your zone may not have enough DNS query history
> in the current period. Set `"lookback_override_days": 30` in accounts.json
> to force a 30-day lookback.

---

## Phase 3 — Send a Test Email
**Goal:** Get the report delivered to your email as a PDF attachment.
**Time:** ~10 minutes

### Step 3.1 — Add SMTP credentials to .env

Open `heroku/.env` and fill in the SMTP section:

```
SMTP_HOST=your.smtp.server.com
SMTP_PORT=465
SMTP_USERNAME=your-smtp-username
SMTP_PASSWORD=your-smtp-password
SMTP_FROM_EMAIL=reports@yourdomain.com
```

> **Port guide:**
> - Port 465 → use `use_tls: true` (most common for modern SMTP)
> - Port 587 → use `use_starttls: true` in accounts.json smtp_profile
> - Port 25  → usually blocked by ISPs, avoid

### Step 3.2 — Send a test report now

```bash
# From the heroku/ directory:
python -m src.main --run-now all
```

This generates the report and emails it immediately.

### Step 3.3 — Check your inbox

- Check **kjeg@protonmail.com** (or whatever you set as recipient)
- You should receive an email with:
  - Subject: `[DNS Report] Hourly DNS Report — yourdomain.com`
  - A summary of key metrics in the email body
  - The full report as a **PDF attachment**

**✅ Phase 3 Complete** when the PDF arrives in your inbox and looks correct.

> **If the email doesn't arrive:** Check spam/junk first. Then verify SMTP
> credentials by running `python -m src.main --preview` (no SMTP needed) to
> confirm the data side still works.

---

## Phase 4 — Move to Cloudflare Workers (Cloud, No Local Machine Needed)
**Goal:** The report runs automatically in Cloudflare's cloud — your computer
doesn't need to be on.
**Time:** ~25 minutes

### Step 4.1 — Install Wrangler (Cloudflare's deployment tool)

```bash
npm install -g wrangler
```

### Step 4.2 — Log in to Cloudflare via Wrangler

```bash
npx wrangler login
```

This opens a browser. Log in with your Cloudflare credentials and click Allow.

### Step 4.3 — Set up a Resend account (free email API)

Workers cannot use raw SMTP, so we use Resend's free HTTP API instead.

1. Go to **resend.com** → Sign up (free)
2. Add and verify your sending domain (or use their test domain for now)
3. Go to **API Keys** → Create API Key → copy it

### Step 4.4 — Create the Workers account config file

Create a new file: `config/accounts.workers.json`

This is the same as `accounts.json` but **without the smtp_profiles section**
and with one extra field (`api_token_secret`):

```json
{
  "accounts": [
    {
      "id": "my-account",
      "display_name": "My Company",
      "api_token_secret": "CF_TOKEN_MY_ACCOUNT",
      "cloudflare_account_id": "PASTE YOUR ACCOUNT ID HERE",
      "zones": [
        {
          "zone_id": "PASTE YOUR ZONE ID HERE",
          "zone_name": "yourdomain.com"
        }
      ],
      "schedule": {
        "frequency": "hourly"
      },
      "email": {
        "recipients": ["kjeg@protonmail.com"],
        "subject_prefix": "[DNS Report]"
      },
      "report": {
        "title": "My Company — DNS Report",
        "include_dns_records": true,
        "top_queries_limit": 15,
        "lookback_override_days": null
      }
    }
  ]
}
```

### Step 4.5 — Upload config to Cloudflare KV

```bash
npx wrangler kv key put \
  --namespace-id=386e4fff563a47f3bcf7af1f2581f8c7 \
  accounts_config \
  "$(cat config/accounts.workers.json)"
```

### Step 4.6 — Set your secrets

Run each command below. It will prompt you to paste the value — nothing is
stored in any file.

```bash
cd workers

# Your Cloudflare API token (name must match api_token_secret in your JSON above)
npx wrangler secret put CF_TOKEN_MY_ACCOUNT

# Resend email API
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM_ADDRESS    # e.g. reports@yourdomain.com
npx wrangler secret put EMAIL_FROM_NAME       # e.g. Cloudflare DNS Reports
```

### Step 4.7 — Install Workers dependencies and deploy

```bash
cd workers
npm install
npm run deploy
```

You should see:
```
✅ Deployed cloudflare-dns-auto-report
   https://cloudflare-dns-auto-report.YOUR-SUBDOMAIN.workers.dev
```

### Step 4.8 — Test it immediately (without waiting for cron)

```bash
npm run test-daily
```

Check your email — a report should arrive within a minute or two.

**✅ Phase 4 Complete** when:
- The Worker is deployed
- A test trigger sends a report to your inbox
- Your computer is turned off and reports still arrive on schedule :)

---

## Phase 5 — Web UI (Coming Next)
**Goal:** A simple web page where you (or a non-technical team member) can:
- Add a new client (enter their zone ID, email, and preferred schedule)
- See all configured clients and their last report status
- Trigger a report immediately for any client
- Remove a client

This phase requires building a Cloudflare Pages + D1 (database) application.
We'll tackle this in the next build session.

---

## Phase 6 — Full MSP Production
**Goal:** Your team members can log in, add client accounts, and reports go out
automatically. Clients receive clean, professional reports without anyone
manually running scripts.

This builds directly on Phase 5.

---

## Troubleshooting Quick Reference

| Problem | Likely cause | Fix |
|---|---|---|
| Postman returns 401 | Bad API token | Re-check the token in your Postman environment |
| Empty DNS analytics | Date range has no data | Try `START_DATE` = 7 days ago |
| `--preview` crashes | Missing Python dependency | Re-run `pip install -r requirements.txt` |
| PDF fails, HTML works | WeasyPrint not installed | `pip install weasyprint` |
| Email not received | SMTP credentials wrong | Check spam folder first; re-verify host/port/credentials |
| Worker not triggering | Cron takes up to 15 min | Wait — or run `npm run test-daily` to force it |
| Worker secret error | Wrong secret name | Name in `api_token_secret` must exactly match `wrangler secret put` name |

---

## Frequency Reference

| Setting | When does it run? | Reports cover |
|---|---|---|
| `hourly` | Every hour at :00 UTC | Past 1 day (for testing) |
| `daily` | Every day at 08:00 UTC | Previous day |
| `weekly` | Every Monday at 08:00 UTC | Previous 7 days |
| `monthly` | 1st of each month at 08:00 UTC | Previous calendar month |

> **For production MSP clients:** use `monthly` for casual awareness reports,
> `weekly` for clients who are more hands-on, and `daily` only if a client has
> a specific reason to want daily visibility.
