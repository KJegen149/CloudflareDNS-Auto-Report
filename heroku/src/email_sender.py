"""
Email sender: sends the DNS report as a rich HTML email via SMTP,
with an optional PDF attachment when PDF generation is available.

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
    pdf_bytes: bytes | None = None,
    pdf_filename: str | None = None,
) -> None:
    """
    Send a DNS report email via SMTP.

    The full HTML report is the email body. If pdf_bytes is provided it is
    attached as a PDF; if PDF generation failed or is unavailable, the email
    is still sent without an attachment.

    Args:
        smtp:         Resolved SMTP profile dict (from config_loader).
        recipients:   List of recipient email addresses.
        subject:      Email subject line.
        html_body:    Full HTML report (or summary HTML).
        pdf_bytes:    Optional PDF attachment bytes.
        pdf_filename: Filename for the PDF attachment.
    """
    msg = MIMEMultipart("mixed")
    msg["From"]    = f'{smtp["from_name"]} <{smtp["from_email"]}>'
    msg["To"]      = ", ".join(recipients)
    msg["Subject"] = subject

    msg.attach(MIMEText(html_body, "html"))

    if pdf_bytes:
        attachment = MIMEBase("application", "pdf")
        attachment.set_payload(pdf_bytes)
        encoders.encode_base64(attachment)
        attachment.add_header(
            "Content-Disposition",
            "attachment",
            filename=pdf_filename or "dns-report.pdf",
        )
        msg.attach(attachment)

    host = smtp["host"]
    port = smtp["port"]

    logger.info(
        "Sending report to %d recipient(s) via %s:%d (PDF: %s)",
        len(recipients), host, port, "attached" if pdf_bytes else "not included",
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


def build_subject(account_config: dict, zone_name: str, frequency: str, period: dict) -> str:
    prefix = account_config.get("email", {}).get("subject_prefix", "[DNS Report]")
    start  = period["start"]
    end    = period["end"]
    return f"{prefix} {frequency.title()} DNS Report — {zone_name} ({start} to {end})"

