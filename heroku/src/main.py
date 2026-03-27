"""
Entry point for the Cloudflare DNS Auto-Report Heroku worker.

Usage:
  # ── Local preview (no email sent) ──────────────────────────────────────────
  python -m src.main --preview                    # Save all reports to ./reports/ and open in browser
  python -m src.main --preview --out ./my-folder  # Save to a custom folder
  python -m src.main --preview --no-open          # Save without opening browser

  # ── Send immediately ────────────────────────────────────────────────────────
  python -m src.main --run-now all                # Generate + email all accounts now
  python -m src.main --run-now <account-id>       # Generate + email one account

  # ── Scheduler daemon ────────────────────────────────────────────────────────
  python -m src.main                              # Start scheduler, fires on configured schedules
"""
import argparse
import logging
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

from dotenv import load_dotenv

# Load .env file before importing anything that reads env vars
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

from .config_loader import load_config
from .cloudflare_graphql import CloudflareClient
from .report_generator import ReportGenerator, compute_metrics
from .pdf_generator import html_to_pdf
from .email_sender import send_report, build_subject
from .scheduler import build_scheduler

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

_TEMPLATES_DIR = str(Path(__file__).parent.parent / "templates")


def _fetch_and_render(account: dict) -> list[tuple[dict, dict, dict, str]]:
    """
    Fetch data and render HTML for all zones in an account.
    Returns a list of (report_data, zone_config, metrics, html) tuples.
    """
    frequency = account.get("schedule", {}).get("frequency", "monthly")
    lookback  = account.get("report", {}).get("lookback_override_days")
    client    = CloudflareClient(account["cloudflare_api_token"])
    generator = ReportGenerator(_TEMPLATES_DIR)
    results   = []

    for zone in account.get("zones", []):
        zone_id   = zone["zone_id"]
        zone_name = zone.get("zone_name", zone_id)
        logger.info("Fetching %s data for zone: %s", frequency, zone_name)

        try:
            report_data = client.collect_report_data(zone_id, frequency, lookback)
        except Exception:
            logger.exception("Failed to collect data for zone %s — skipping", zone_name)
            continue

        html    = generator.generate_html(account, zone, report_data)
        metrics = compute_metrics(report_data["analytics"], report_data["dns_records"])
        results.append((report_data, zone, metrics, html))

    return results


def _save_locally(account: dict, out_dir: Path, open_browser: bool) -> None:
    """
    Generate reports for all zones and save as HTML + PDF to out_dir.
    Does NOT send any email. Opens the HTML file in the browser if open_browser=True.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    frequency = account.get("schedule", {}).get("frequency", "monthly")

    for report_data, zone, metrics, html in _fetch_and_render(account):
        zone_name = zone.get("zone_name", zone["zone_id"])
        period    = report_data["period"]
        stem      = f"dns-report-{zone_name}-{frequency}-{period['end']}".replace(" ", "_")

        # Always save HTML (instant, no extra deps)
        html_path = out_dir / f"{stem}.html"
        html_path.write_text(html, encoding="utf-8")
        logger.info("HTML report saved: %s", html_path)

        # Also save PDF if WeasyPrint is available
        try:
            pdf_bytes = html_to_pdf(html)
            pdf_path  = out_dir / f"{stem}.pdf"
            pdf_path.write_bytes(pdf_bytes)
            logger.info("PDF report saved:  %s", pdf_path)
        except Exception as exc:
            logger.warning("PDF generation skipped (%s) — HTML report is still available.", exc)

        if open_browser:
            webbrowser.open(html_path.resolve().as_uri())


def _generate_and_send(account: dict) -> None:
    """Full pipeline: fetch → render → (optional PDF) → email for one account."""
    for report_data, zone, metrics, html in _fetch_and_render(account):
        zone_name  = zone.get("zone_name", zone["zone_id"])
        period     = report_data["period"]
        frequency  = period["frequency"]

        # Try PDF — attach it if successful, send HTML-only if not
        pdf_bytes = None
        pdf_filename = None
        try:
            pdf_bytes    = html_to_pdf(html)
            pdf_filename = (
                f"dns-report-{zone_name}-{frequency}-{period['end']}.pdf"
                .replace(" ", "_")
            )
        except Exception as exc:
            logger.warning("PDF generation skipped (%s) — sending HTML email only.", exc)

        recipients = account.get("email", {}).get("recipients", [])
        subject    = build_subject(account, zone_name, frequency, period)

        try:
            send_report(account["smtp"], recipients, subject, html, pdf_bytes, pdf_filename)
        except Exception:
            logger.exception("Email delivery failed for zone %s", zone_name)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cloudflare DNS Auto-Report",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help="Generate reports locally (no email). Great for testing.",
    )
    parser.add_argument(
        "--out",
        metavar="DIR",
        default="./reports",
        help="Output folder for --preview (default: ./reports)",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="With --preview: save files but don't open browser.",
    )
    parser.add_argument(
        "--run-now",
        metavar="ACCOUNT_ID",
        help="Generate + email a report now. Use 'all' for every account.",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="Path to accounts.json (overrides ACCOUNTS_CONFIG_PATH env var)",
    )
    args = parser.parse_args()

    # Only resolve SMTP credentials for modes that actually send email
    need_smtp = bool(args.run_now) or (not args.preview and not args.run_now)
    config    = load_config(args.config, require_smtp=need_smtp)
    accounts  = config["accounts"]

    if not accounts:
        logger.error("No accounts configured. Check your accounts.json.")
        sys.exit(1)

    # ── Local preview mode (no email) ──────────────────────────────────────────
    if args.preview:
        out_dir      = Path(args.out).resolve()
        open_browser = not args.no_open
        logger.info("Preview mode — saving reports to: %s", out_dir)
        for account in accounts:
            _save_locally(account, out_dir, open_browser)
        logger.info("Done. Reports saved to: %s", out_dir)
        return

    # ── Send immediately ───────────────────────────────────────────────────────
    if args.run_now:
        target = args.run_now.lower()
        targets = accounts if target == "all" else [
            a for a in accounts if a["id"] == target
        ]
        if not targets:
            logger.error("No account with id '%s' found.", target)
            sys.exit(1)
        for account in targets:
            logger.info("Running immediate report for: %s", account["id"])
            _generate_and_send(account)
        return

    # ── Scheduler daemon mode ──────────────────────────────────────────────────
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
