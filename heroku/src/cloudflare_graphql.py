"""
Cloudflare API client.

Uses the GraphQL Analytics API for DNS query metrics and the REST API for
zone info, DNS records, and DNSSEC status.

GraphQL endpoint: https://api.cloudflare.com/client/v4/graphql
REST base:        https://api.cloudflare.com/client/v4

Useful resources:
  - GraphQL schema explorer: https://graphql.cloudflare.com/explorer
  - DNS analytics docs:      https://developers.cloudflare.com/dns/additional-options/analytics/
  - API token scopes needed: Zone.DNS:Read, Zone.Zone:Read, Zone.Analytics:Read
"""
import logging
from datetime import date, timedelta
from typing import Optional

import requests

logger = logging.getLogger(__name__)

GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql"
REST_BASE = "https://api.cloudflare.com/client/v4"

# ── GraphQL query ──────────────────────────────────────────────────────────────
# Uses aliased fields to run four grouped analytics queries in one round-trip.
# The dnsAnalyticsAdaptiveGroups dataset implicitly groups by whichever
# dimension fields are selected in each alias.
DNS_ANALYTICS_QUERY = """
query DnsReport($zoneTag: String!, $startDate: Date!, $endDate: Date!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      byDate: dnsAnalyticsAdaptiveGroups(
        limit: 5000
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { queryCount uncachedCount staleCount }
      }
      byQueryType: dnsAnalyticsAdaptiveGroups(
        limit: 20
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [sum_queryCount_DESC]
      ) {
        dimensions { queryType }
        sum { queryCount }
      }
      byResponseCode: dnsAnalyticsAdaptiveGroups(
        limit: 20
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [sum_queryCount_DESC]
      ) {
        dimensions { responseCode }
        sum { queryCount }
      }
      byQueryName: dnsAnalyticsAdaptiveGroups(
        limit: 15
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [sum_queryCount_DESC]
      ) {
        dimensions { queryName }
        sum { queryCount }
      }
    }
  }
}
"""


class CloudflareAPIError(Exception):
    pass


class CloudflareClient:
    """Thread-safe Cloudflare API client for a single API token."""

    def __init__(self, api_token: str, timeout: int = 30):
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            }
        )
        self.timeout = timeout

    # ── REST helpers ───────────────────────────────────────────────────────────

    def get_zone_info(self, zone_id: str) -> dict:
        """Fetch zone metadata (name, status, plan, nameservers, etc.)."""
        url = f"{REST_BASE}/zones/{zone_id}"
        resp = self.session.get(url, timeout=self.timeout)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise CloudflareAPIError(f"Zone info failed: {data.get('errors')}")
        return data["result"]

    def get_dns_records(self, zone_id: str) -> list:
        """Fetch all DNS records for a zone, handling pagination."""
        records = []
        page = 1
        while True:
            url = f"{REST_BASE}/zones/{zone_id}/dns_records"
            resp = self.session.get(
                url,
                params={"page": page, "per_page": 100, "order": "type"},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                raise CloudflareAPIError(f"DNS records failed: {data.get('errors')}")
            records.extend(data["result"])
            info = data.get("result_info", {})
            if page >= info.get("total_pages", 1):
                break
            page += 1
        logger.debug("Fetched %d DNS records for zone %s", len(records), zone_id)
        return records

    def get_dnssec_status(self, zone_id: str) -> dict:
        """Fetch DNSSEC status. Returns safe default on error."""
        try:
            url = f"{REST_BASE}/zones/{zone_id}/dnssec"
            resp = self.session.get(url, timeout=self.timeout)
            resp.raise_for_status()
            data = resp.json()
            if data.get("success"):
                return data["result"]
        except Exception as exc:
            logger.warning("Could not fetch DNSSEC status for zone %s: %s", zone_id, exc)
        return {"status": "unknown"}

    # ── GraphQL analytics ──────────────────────────────────────────────────────

    def get_dns_analytics(self, zone_id: str, start_date: str, end_date: str) -> dict:
        """
        Fetch DNS query analytics via GraphQL.

        Args:
            zone_id:    Cloudflare zone ID.
            start_date: ISO date string, e.g. '2026-03-01'.
            end_date:   ISO date string, e.g. '2026-03-25'.

        Returns:
            Dict with keys byDate, byQueryType, byResponseCode, byQueryName.
            Each is a list of grouped rows from dnsAnalyticsAdaptiveGroups.
        """
        payload = {
            "query": DNS_ANALYTICS_QUERY,
            "variables": {
                "zoneTag": zone_id,
                "startDate": start_date,
                "endDate": end_date,
            },
        }
        resp = self.session.post(GRAPHQL_ENDPOINT, json=payload, timeout=self.timeout)
        resp.raise_for_status()
        result = resp.json()

        if result.get("errors"):
            raise CloudflareAPIError(f"GraphQL errors: {result['errors']}")

        zones = result.get("data", {}).get("viewer", {}).get("zones", [])
        if not zones:
            logger.warning("No DNS analytics data returned for zone %s (%s – %s)", zone_id, start_date, end_date)
            return {"byDate": [], "byQueryType": [], "byResponseCode": [], "byQueryName": []}

        return zones[0]

    # ── Convenience ────────────────────────────────────────────────────────────

    def collect_report_data(
        self,
        zone_id: str,
        frequency: str,
        lookback_override_days: Optional[int] = None,
    ) -> dict:
        """
        Collect all data required to render a report for one zone.

        The date range is computed automatically from frequency:
          daily   → yesterday only
          weekly  → previous 7 days
          monthly → previous calendar month

        lookback_override_days overrides the above when set.
        """
        today = date.today()

        if lookback_override_days:
            end = today - timedelta(days=1)
            start = end - timedelta(days=lookback_override_days - 1)
        elif frequency == "daily":
            start = end = today - timedelta(days=1)
        elif frequency == "weekly":
            end = today - timedelta(days=1)
            start = end - timedelta(days=6)
        else:  # monthly
            # First to last day of the previous calendar month
            first_of_this_month = today.replace(day=1)
            end = first_of_this_month - timedelta(days=1)
            start = end.replace(day=1)

        start_str, end_str = start.isoformat(), end.isoformat()
        logger.info("Collecting report data for zone %s (%s → %s)", zone_id, start_str, end_str)

        zone_info = self.get_zone_info(zone_id)
        dns_records = self.get_dns_records(zone_id)
        dnssec = self.get_dnssec_status(zone_id)
        analytics = self.get_dns_analytics(zone_id, start_str, end_str)

        return {
            "zone_info": zone_info,
            "dns_records": dns_records,
            "dnssec": dnssec,
            "analytics": analytics,
            "period": {
                "start": start_str,
                "end": end_str,
                "frequency": frequency,
            },
        }
