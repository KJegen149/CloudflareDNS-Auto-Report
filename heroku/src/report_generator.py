"""
Report generator: transforms raw Cloudflare API data into a rendered HTML
report with embedded matplotlib charts (base64 PNG).
"""
import base64
import io
import logging
from datetime import datetime
from typing import Optional

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend — must be set before pyplot import
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from jinja2 import Environment, FileSystemLoader, select_autoescape

logger = logging.getLogger(__name__)

# ── Color palette ──────────────────────────────────────────────────────────────
BURGUNDY       = "#722F37"
BURGUNDY_LIGHT = "#9B4D57"
BURGUNDY_DARK  = "#4A1E24"
STEEL_BLUE     = "#2E6DA4"
BLUE_LIGHT     = "#5BA3D9"
FOREST_GREEN   = "#2D7D46"
GREEN_LIGHT    = "#52B775"
AMBER          = "#D97706"
RED            = "#C0392B"
GRAY           = "#888888"
GRAY_LIGHT     = "#CCCCCC"
NEAR_BLACK     = "#1a1a1a"

CHART_PALETTE = [
    BURGUNDY, STEEL_BLUE, FOREST_GREEN, AMBER,
    BURGUNDY_LIGHT, BLUE_LIGHT, GREEN_LIGHT, "#A855F7",
    "#06B6D4", "#EC4899", "#64748B", "#F97316",
]

RESPONSE_CODE_COLORS = {
    "NOERROR":  FOREST_GREEN,
    "NXDOMAIN": BURGUNDY,
    "SERVFAIL": RED,
    "REFUSED":  AMBER,
    "FORMERR":  STEEL_BLUE,
    "NOTIMP":   GRAY,
}


# ── Chart utilities ────────────────────────────────────────────────────────────

def _fig_to_b64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


def _human(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}K"
    return str(n)


def _human_fmt(val, _pos):
    return _human(int(val))


def _style_ax(ax):
    ax.set_facecolor("#FAFAFA")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(GRAY_LIGHT)
    ax.spines["bottom"].set_color(GRAY_LIGHT)
    ax.tick_params(colors=GRAY, labelsize=8)
    ax.grid(axis="y", alpha=0.25, linestyle="--", zorder=0)


# ── Individual chart generators ────────────────────────────────────────────────

def chart_query_volume(by_date: list) -> Optional[str]:
    """Stacked bar chart: total vs uncached queries by day."""
    if not by_date:
        return None

    dates  = [d["dimensions"]["date"][-5:] for d in by_date]
    total  = [d["sum"]["queryCount"] for d in by_date]
    unc    = [d["sum"].get("uncachedCount", 0) for d in by_date]
    cached = [t - u for t, u in zip(total, unc)]

    fig, ax = plt.subplots(figsize=(11, 4))
    fig.patch.set_facecolor("white")
    _style_ax(ax)

    x = list(range(len(dates)))
    ax.bar(x, cached, color=BURGUNDY,    alpha=0.85, label="Cached",   zorder=3)
    ax.bar(x, unc,    color=STEEL_BLUE,  alpha=0.75, label="Uncached", zorder=3, bottom=cached)

    ax.set_xticks(x)
    ax.set_xticklabels(dates, rotation=45, ha="right", fontsize=7)
    ax.set_ylabel("DNS Queries", fontsize=9, color=GRAY)
    ax.set_title("Query Volume by Day", fontsize=13, fontweight="bold", color=NEAR_BLACK, pad=10)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(_human_fmt))
    ax.legend(loc="upper right", fontsize=8, framealpha=0.85)
    ax.tick_params(axis="x", which="both", length=0)

    plt.tight_layout()
    return _fig_to_b64(fig)


def chart_query_types(by_type: list) -> Optional[str]:
    """Donut chart for DNS record type breakdown."""
    if not by_type:
        return None

    items  = by_type[:8]
    labels = [d["dimensions"]["queryType"] for d in items]
    values = [d["sum"]["queryCount"] for d in items]
    if sum(values) == 0:
        return None

    fig, ax = plt.subplots(figsize=(7, 5.5))
    fig.patch.set_facecolor("white")

    wedges, texts, autotexts = ax.pie(
        values,
        labels=labels,
        autopct=lambda p: f"{p:.1f}%" if p > 3 else "",
        colors=CHART_PALETTE[:len(labels)],
        pctdistance=0.80,
        startangle=90,
        wedgeprops={"width": 0.52, "linewidth": 0.8, "edgecolor": "white"},
    )
    for t in texts:
        t.set_fontsize(9); t.set_color(NEAR_BLACK)
    for a in autotexts:
        a.set_fontsize(8); a.set_color("white"); a.set_fontweight("bold")

    ax.set_title("Query Types", fontsize=13, fontweight="bold", color=NEAR_BLACK, pad=12)
    plt.tight_layout()
    return _fig_to_b64(fig)


def chart_response_codes(by_code: list) -> Optional[str]:
    """Donut chart with semantic colors for DNS response codes."""
    if not by_code:
        return None

    items  = by_code[:7]
    labels = [d["dimensions"]["responseCode"] for d in items]
    values = [d["sum"]["queryCount"] for d in items]
    if sum(values) == 0:
        return None

    colors = [RESPONSE_CODE_COLORS.get(l, GRAY) for l in labels]

    fig, ax = plt.subplots(figsize=(7, 5.5))
    fig.patch.set_facecolor("white")

    wedges, texts, autotexts = ax.pie(
        values,
        labels=labels,
        autopct=lambda p: f"{p:.1f}%" if p > 2 else "",
        colors=colors,
        pctdistance=0.80,
        startangle=90,
        wedgeprops={"width": 0.52, "linewidth": 0.8, "edgecolor": "white"},
    )
    for t in texts:
        t.set_fontsize(9); t.set_color(NEAR_BLACK)
    for a in autotexts:
        a.set_fontsize(8); a.set_color("white"); a.set_fontweight("bold")

    ax.set_title("Response Codes", fontsize=13, fontweight="bold", color=NEAR_BLACK, pad=12)
    plt.tight_layout()
    return _fig_to_b64(fig)


def chart_top_domains(by_name: list) -> Optional[str]:
    """Horizontal bar chart for top queried domain names."""
    if not by_name:
        return None

    items  = by_name[:12]
    names  = [d["dimensions"]["queryName"] for d in items]
    counts = [d["sum"]["queryCount"] for d in items]

    display = [n[:52] + "…" if len(n) > 52 else n for n in names]
    # Reverse so highest is at top
    display = display[::-1]
    counts_r = counts[::-1]

    fig, ax = plt.subplots(figsize=(11, max(4, len(items) * 0.55 + 1.5)))
    fig.patch.set_facecolor("white")
    _style_ax(ax)
    ax.grid(axis="x", alpha=0.25, linestyle="--", zorder=0)
    ax.grid(axis="y", alpha=0, zorder=0)

    y = list(range(len(display)))
    bars = ax.barh(y, counts_r, color=STEEL_BLUE, alpha=0.85, zorder=3)

    for bar, count in zip(bars, counts_r):
        ax.text(
            bar.get_width() * 1.008, bar.get_y() + bar.get_height() / 2,
            _human(count), va="center", ha="left", fontsize=7, color=GRAY,
        )

    ax.set_yticks(y)
    ax.set_yticklabels(display, fontsize=8)
    ax.set_xlabel("Query Count", fontsize=9, color=GRAY)
    ax.set_title("Top Queried Domains", fontsize=13, fontweight="bold", color=NEAR_BLACK, pad=10)
    ax.xaxis.set_major_formatter(mticker.FuncFormatter(_human_fmt))
    ax.tick_params(axis="y", which="both", length=0)

    plt.tight_layout()
    return _fig_to_b64(fig)


# ── Summary metrics ────────────────────────────────────────────────────────────

def compute_metrics(analytics: dict, dns_records: list) -> dict:
    by_date = analytics.get("byDate", [])
    by_code = analytics.get("byResponseCode", [])

    total     = sum(d["sum"]["queryCount"] for d in by_date)
    uncached  = sum(d["sum"].get("uncachedCount", 0) for d in by_date)
    cached    = total - uncached
    cache_pct = round(cached / total * 100, 1) if total else 0

    code_map  = {d["dimensions"]["responseCode"]: d["sum"]["queryCount"] for d in by_code}
    noerror   = code_map.get("NOERROR",  0)
    nxdomain  = code_map.get("NXDOMAIN", 0)
    servfail  = code_map.get("SERVFAIL", 0)

    nx_pct      = round(nxdomain / total * 100, 2) if total else 0
    success_pct = round(noerror  / total * 100, 1) if total else 0

    record_types: dict[str, int] = {}
    for r in dns_records:
        rtype = r.get("type", "OTHER")
        record_types[rtype] = record_types.get(rtype, 0) + 1

    return {
        "total_queries":    total,
        "cached_queries":   cached,
        "uncached_queries": uncached,
        "cache_hit_pct":    cache_pct,
        "noerror_count":    noerror,
        "nxdomain_count":   nxdomain,
        "nxdomain_pct":     nx_pct,
        "servfail_count":   servfail,
        "success_pct":      success_pct,
        "total_dns_records": len(dns_records),
        "record_type_counts": dict(sorted(record_types.items(), key=lambda x: -x[1])),
    }


# ── Main renderer ──────────────────────────────────────────────────────────────

class ReportGenerator:
    def __init__(self, templates_dir: str):
        self.jinja = Environment(
            loader=FileSystemLoader(templates_dir),
            autoescape=select_autoescape(["html"]),
        )
        self.jinja.filters["human"] = _human
        self.jinja.filters["pct"]   = lambda v: f"{v:.1f}%"

    def generate_html(
        self,
        account_config: dict,
        zone_config: dict,
        report_data: dict,
    ) -> str:
        analytics   = report_data["analytics"]
        dns_records = report_data["dns_records"]
        period      = report_data["period"]
        frequency   = period["frequency"]

        charts = {
            "volume":   chart_query_volume(analytics.get("byDate", [])),
            "types":    chart_query_types(analytics.get("byQueryType", [])),
            "codes":    chart_response_codes(analytics.get("byResponseCode", [])),
            "domains":  chart_top_domains(analytics.get("byQueryName", [])),
        }

        metrics = compute_metrics(analytics, dns_records)

        sorted_records = sorted(
            dns_records, key=lambda r: (r.get("type", ""), r.get("name", ""))
        )

        period_label = {
            "daily":   "Yesterday",
            "weekly":  "Past 7 Days",
            "monthly": "Previous Month",
        }.get(frequency, frequency.title())

        template = self.jinja.get_template("report.html.j2")
        return template.render(
            account        = account_config,
            zone           = zone_config,
            zone_info      = report_data["zone_info"],
            dnssec         = report_data["dnssec"],
            period         = period,
            period_label   = period_label,
            frequency      = frequency.title(),
            metrics        = metrics,
            charts         = charts,
            analytics      = analytics,
            dns_records    = sorted_records,
            generated_at   = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
            report_title   = account_config.get("report", {}).get(
                "title", account_config.get("display_name", "DNS Report")
            ),
            include_records = account_config.get("report", {}).get("include_dns_records", True),
        )
