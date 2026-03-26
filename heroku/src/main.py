"""
Entry point for the Cloudflare DNS Auto-Report Heroku worker.

Usage:
  python -m src.main                          # Start the scheduler daemon
  python -m src.main --run-now <account-id>   # Generate + send a report immediately
  python -m src.main --run-now all            # Run all accounts immediately (useful for testing)
"""
import argparse
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load .env file before importing anything that reads env vars
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

from .config_loader import load_config
from .cloudflare_graphql import CloudflareClient
from .report_generator import ReportGenerator
from .pdf_generator import html_to_pdf
from .email_sender import send_report, build_email_body, build_subject
from .scheduler import build_scheduler

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

_TEMPLATES_DIR = str(Path(__file__).parent.parent / "templates")


def _generate_and_send(account: dict) -> None:
    """Full pipeline: fetch → render → PDF → email for one account."""
    frequency = account.get("schedule", {}).get("frequency", "monthly")
    lookback  = account.get("report", {}).get("lookback_override_days")

    client    = CloudflareClient(account["cloudflare_api_token"])
    generator = ReportGenerator(_TEMPLATES_DIR)

    for zone in account.get("zones", []):
        zone_id   = zone["zone_id"]
        zone_name = zone.get("zone_name", zone_id)
        logger.info("Generating %s report for zone: %s", frequency, zone_name)

        try:
            report_data = client.collect_report_data(zone_id, frequency, lookback)
        except Exception:
            logger.exception("Failed to collect data for zone %s — skipping", zone_name)
            continue

        html = generator.generate_html(account, zone, report_data)

        try:
            pdf_bytes = html_to_pdf(html)
        except Exception:
            logger.exception("PDF generation failed for zone %s — skipping", zone_name)
            continue

        metrics   = {}
        from .report_generator import compute_metrics
        metrics   = compute_metrics(report_data["analytics"], report_data["dns_records"])
        period    = report_data["period"]
        recipients = account.get("email", {}).get("recipients", [])
        subject   = build_subject(account, zone_name, frequency, period)
        body      = build_email_body(
            account.get("display_name", ""), zone_name, frequency, metrics, period
        )
        filename  = (
            f"dns-report-{zone_name}-{frequency}-{period['end']}.pdf"
            .replace(" ", "_")
        )

        try:
            send_report(account["smtp"], recipients, subject, body, pdf_bytes, filename)
        except Exception:
            logger.exception("Email delivery failed for zone %s", zone_name)


def main() -> None:
    parser = argparse.ArgumentParser(description="Cloudflare DNS Auto-Report")
    parser.add_argument(
        "--run-now",
        metavar="ACCOUNT_ID",
        help="Run a report immediately for the given account ID (or 'all')",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="Path to accounts.json (overrides ACCOUNTS_CONFIG_PATH env var)",
    )
    args = parser.parse_args()

    config   = load_config(args.config)
    accounts = config["accounts"]

    if not accounts:
        logger.error("No accounts configured. Check your accounts.json.")
        sys.exit(1)

    if args.run_now:
        target = args.run_now.lower()
        if target == "all":
            targets = accounts
        else:
            targets = [a for a in accounts if a["id"] == target]
            if not targets:
                logger.error("No account with id '%s' found.", target)
                sys.exit(1)

        for account in targets:
            logger.info("Running immediate report for: %s", account["id"])
            _generate_and_send(account)
        return

    # ── Scheduler mode ─────────────────────────────────────────────────────────
    if os.environ.get("SEND_TEST_ON_STARTUP", "false").lower() == "true":
        logger.info("SEND_TEST_ON_STARTUP is set — running all reports now")
        for account in accounts:
            _generate_and_send(account)

    scheduler = build_scheduler(accounts, _generate_and_send)
    logger.info("Scheduler started. Waiting for cron triggers…")
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler stopped.")


if __name__ == "__main__":
    main()
