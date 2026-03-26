"""
Email sender: sends the DNS report PDF as an attachment via SMTP.

Supports TLS (port 465) and STARTTLS (port 587). Configure via smtp_profile
entries in accounts.json.
"""
import logging
import smtplib
from datetime import datetime
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def send_report(
    smtp: dict,
    recipients: list[str],
    subject: str,
    html_body: str,
    pdf_bytes: bytes,
    pdf_filename: str,
) -> None:
    """
    Send a PDF report email via SMTP.

    Args:
        smtp:         Resolved SMTP profile dict (from config_loader).
        recipients:   List of recipient email addresses.
        subject:      Email subject line.
        html_body:    HTML email body (summary/intro, not the full report).
        pdf_bytes:    PDF attachment bytes.
        pdf_filename: Filename for the PDF attachment.
    """
    msg = MIMEMultipart("mixed")
    msg["From"]    = f'{smtp["from_name"]} <{smtp["from_email"]}>'
    msg["To"]      = ", ".join(recipients)
    msg["Subject"] = subject

    # ── HTML body (brief intro with key stats) ─────────────────────────────────
    msg.attach(MIMEText(html_body, "html"))

    # ── PDF attachment ─────────────────────────────────────────────────────────
    attachment = MIMEBase("application", "pdf")
    attachment.set_payload(pdf_bytes)
    encoders.encode_base64(attachment)
    attachment.add_header(
        "Content-Disposition",
        "attachment",
        filename=pdf_filename,
    )
    msg.attach(attachment)

    # ── Send ───────────────────────────────────────────────────────────────────
    host = smtp["host"]
    port = smtp["port"]

    logger.info(
        "Sending report to %d recipient(s) via %s:%d", len(recipients), host, port
    )

    if smtp.get("use_tls", True):
        with smtplib.SMTP_SSL(host, port) as server:
            server.login(smtp["username"], smtp["password"])
            server.sendmail(smtp["from_email"], recipients, msg.as_string())
    else:
        with smtplib.SMTP(host, port) as server:
            if smtp.get("use_starttls", False):
                server.starttls()
            server.login(smtp["username"], smtp["password"])
            server.sendmail(smtp["from_email"], recipients, msg.as_string())

    logger.info("Report sent successfully to: %s", ", ".join(recipients))


def build_email_body(
    account_name: str,
    zone_name: str,
    frequency: str,
    metrics: dict,
    period: dict,
) -> str:
    """Build a short HTML email body to accompany the PDF attachment."""
    total    = f"{metrics['total_queries']:,}"
    cache    = f"{metrics['cache_hit_pct']:.1f}%"
    nxd      = f"{metrics['nxdomain_pct']:.2f}%"
    success  = f"{metrics['success_pct']:.1f}%"
    start    = period["start"]
    end      = period["end"]

    return f"""<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
             max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <div style="border-left: 4px solid #722F37; padding-left: 16px; margin-bottom: 24px;">
    <h2 style="margin: 0 0 4px; color: #722F37; font-size: 20px;">
      {frequency.title()} DNS Report
    </h2>
    <p style="margin: 0; color: #666; font-size: 13px;">
      {account_name} &mdash; {zone_name} &mdash; {start} to {end}
    </p>
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
    <tr>
      {"".join(f'''
      <td style="width:25%; padding: 0 6px 0 0;">
        <div style="background:#f8f5f6; border-left:3px solid #722F37;
                    padding:12px; border-radius:3px; text-align:center;">
          <div style="font-size:20px; font-weight:700; color:#722F37;">{v}</div>
          <div style="font-size:10px; color:#888; text-transform:uppercase;
                      letter-spacing:0.5px; margin-top:4px;">{k}</div>
        </div>
      </td>''' for k, v in [
          ("Total Queries", total),
          ("Cache Hit Rate", cache),
          ("NXDOMAIN Rate", nxd),
          ("Success Rate", success),
      ])}
    </tr>
  </table>

  <p style="color: #555; font-size: 13px;">
    The full report is attached as a PDF. Open it for detailed charts, top
    queried domains, record type breakdowns, and your complete DNS record
    inventory.
  </p>

  <hr style="border: none; border-top: 1px solid #e5d7d9; margin: 20px 0;">
  <p style="color: #aaa; font-size: 11px; margin: 0;">
    Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")} &bull;
    CloudflareDNS-Auto-Report
  </p>
</body>
</html>"""


def build_subject(account_config: dict, zone_name: str, frequency: str, period: dict) -> str:
    prefix = account_config.get("email", {}).get("subject_prefix", "[DNS Report]")
    start  = period["start"]
    end    = period["end"]
    return f"{prefix} {frequency.title()} DNS Report — {zone_name} ({start} to {end})"
