"""
PDF generator: converts the rendered HTML report into a PDF byte string
using WeasyPrint.

WeasyPrint renders HTML/CSS to PDF — the HTML template is designed to be
print-ready (A4, page breaks, no JavaScript dependencies).
"""
import logging

logger = logging.getLogger(__name__)


def html_to_pdf(html: str) -> bytes:
    """
    Render an HTML string to PDF and return the raw bytes.

    Args:
        html: Fully rendered HTML document string.

    Returns:
        PDF bytes suitable for attaching to an email.

    Raises:
        ImportError: If WeasyPrint is not installed.
        weasyprint.errors.StylesheetError: On CSS parse errors.
    """
    try:
        from weasyprint import HTML, CSS  # type: ignore
        from weasyprint.text.fonts import FontConfiguration  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "WeasyPrint is required for PDF generation. "
            "Install it with: pip install weasyprint"
        ) from exc

    font_config = FontConfiguration()
    logger.debug("Rendering HTML to PDF via WeasyPrint")
    pdf_bytes = HTML(string=html).write_pdf(font_config=font_config)
    logger.debug("PDF rendered: %d bytes", len(pdf_bytes))
    return pdf_bytes
