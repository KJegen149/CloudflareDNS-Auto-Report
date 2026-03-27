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
        count
      }
      byQueryType: dnsAnalyticsAdaptiveGroups(
        limit: 20
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [count_DESC]
      ) {
        dimensions { queryType }
        count
      }
      byResponseCode: dnsAnalyticsAdaptiveGroups(
        limit: 20
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [count_DESC]
      ) {
        dimensions { responseCode }
        count
      }
      byQueryName: dnsAnalyticsAdaptiveGroups(
        limit: 15
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [count_DESC]
      ) {
        dimensions { queryName }
        count
      }
      byCacheStatus: dnsAnalyticsAdaptiveGroups(
        limit: 5
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [count_DESC]
      ) {
        dimensions { responseCached }
        count
      }
      byColo: dnsAnalyticsAdaptiveGroups(
        limit: 10
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [count_DESC]
      ) {
        dimensions { coloName }
        count
      }
    }
  }
}
"""

# Separate query for HTTP traffic and security events.
# Uses datetime (ISO 8601) for firewallEventsAdaptiveGroups and date for HTTP.
# Wrapped in a try/except at call time — only available for proxied (orange-cloud) zones.
HTTP_SECURITY_QUERY = """
query HttpAndSecurity(
  $zoneTag: String!,
  $startDate: Date!, $endDate: Date!,
  $startDatetime: Time!, $endDatetime: Time!
) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      byCountry: httpRequestsAdaptiveGroups(
        limit: 10
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientCountryName }
      }
      httpTotals: httpRequestsAdaptiveGroups(
        limit: 1
        filter: { date_geq: $startDate, date_leq: $endDate }
      ) {
        sum { visits edgeResponseBytes }
        uniq { uniques }
      }
      securityByAction: firewallEventsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { action }
      }
    }
  }
}
"""


class CloudflareAPIError(Exception):
    pass


def _merge_analytics(chunks: list) -> dict:
    """Merge multiple weekly analytics chunks into one combined result."""
    by_date   = []
    by_type   = {}
    by_code   = {}
    by_name   = {}
    by_cache  = {}
    by_colo   = {}

    for chunk in chunks:
        by_date.extend(chunk.get("byDate", []))

        for row in chunk.get("byQueryType", []):
            k = row["dimensions"]["queryType"]
            by_type[k] = by_type.get(k, 0) + row["count"]

        for row in chunk.get("byResponseCode", []):
            k = row["dimensions"]["responseCode"]
            by_code[k] = by_code.get(k, 0) + row["count"]

        for row in chunk.get("byQueryName", []):
            k = row["dimensions"]["queryName"]
            by_name[k] = by_name.get(k, 0) + row["count"]

        for row in chunk.get("byCacheStatus", []):
            k = row["dimensions"]["responseCached"]
            by_cache[k] = by_cache.get(k, 0) + row["count"]

        for row in chunk.get("byColo", []):
            k = row["dimensions"]["coloName"]
            by_colo[k] = by_colo.get(k, 0) + row["count"]

    def _to_rows(agg: dict, dim_key: str, limit: int) -> list:
        return [
            {"dimensions": {dim_key: k}, "count": v}
            for k, v in sorted(agg.items(), key=lambda x: -x[1])
        ][:limit]

    return {
        "byDate":         by_date,
        "byQueryType":    _to_rows(by_type,  "queryType",     20),
        "byResponseCode": _to_rows(by_code,  "responseCode",  20),
        "byQueryName":    _to_rows(by_name,  "queryName",     15),
        "byCacheStatus":  _to_rows(by_cache, "responseCached", 5),
        "byColo":         _to_rows(by_colo,  "coloName",      10),
    }


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

    _CHUNK_DAYS = 7  # Cloudflare enforces a 1-week max window per zone query

    def get_dns_analytics(self, zone_id: str, start_date: str, end_date: str) -> dict:
        """
        Fetch DNS query analytics via GraphQL.

        Cloudflare caps zone-level dnsAnalyticsAdaptiveGroups queries at 7 days.
        Ranges wider than that are automatically split into weekly chunks and merged.

        Returns:
            Dict with keys byDate, byQueryType, byResponseCode, byQueryName, byCacheStatus.
        """
        start = date.fromisoformat(start_date)
        end   = date.fromisoformat(end_date)

        if (end - start).days < self._CHUNK_DAYS:
            return self._fetch_analytics_chunk(zone_id, start_date, end_date)

        # Split into ≤7-day windows, fetch each, then merge
        chunks = []
        cur = start
        while cur <= end:
            chunk_end = min(cur + timedelta(days=self._CHUNK_DAYS - 1), end)
            logger.debug("Fetching analytics chunk %s → %s for zone %s", cur, chunk_end, zone_id)
            chunks.append(self._fetch_analytics_chunk(zone_id, cur.isoformat(), chunk_end.isoformat()))
            cur = chunk_end + timedelta(days=1)

        return _merge_analytics(chunks)

    def _fetch_analytics_chunk(self, zone_id: str, start_date: str, end_date: str) -> dict:
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
            logger.warning("No DNS analytics data for zone %s (%s – %s)", zone_id, start_date, end_date)
            return {"byDate": [], "byQueryType": [], "byResponseCode": [], "byQueryName": [], "byCacheStatus": [], "byColo": []}

        return zones[0]

    def get_http_security_data(self, zone_id: str, start_date: str, end_date: str) -> dict:
        """
        Fetch HTTP traffic overview and security event counts via GraphQL.

        This data is only available for zones with Cloudflare proxy enabled
        (orange-cloud records). Returns an empty dict on any error so callers
        can treat it as optional.

        Returns:
            Dict with keys: byCountry, httpTotals, securityByAction
        """
        start_dt = f"{start_date}T00:00:00Z"
        end_dt   = f"{end_date}T23:59:59Z"
        payload = {
            "query": HTTP_SECURITY_QUERY,
            "variables": {
                "zoneTag":        zone_id,
                "startDate":      start_date,
                "endDate":        end_date,
                "startDatetime":  start_dt,
                "endDatetime":    end_dt,
            },
        }
        try:
            resp = self.session.post(GRAPHQL_ENDPOINT, json=payload, timeout=self.timeout)
            resp.raise_for_status()
            result = resp.json()
            if result.get("errors"):
                logger.warning("HTTP/security GraphQL errors for zone %s: %s", zone_id, result["errors"])
                return {}
            zones = result.get("data", {}).get("viewer", {}).get("zones", [])
            if not zones:
                return {}
            return zones[0]
        except Exception as exc:
            logger.warning("HTTP/security data unavailable for zone %s (proxy may be off): %s", zone_id, exc)
            return {}

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

        zone_info    = self.get_zone_info(zone_id)
        dns_records  = self.get_dns_records(zone_id)
        dnssec       = self.get_dnssec_status(zone_id)
        analytics    = self.get_dns_analytics(zone_id, start_str, end_str)
        http_security = self.get_http_security_data(zone_id, start_str, end_str)

        return {
            "zone_info":     zone_info,
            "dns_records":   dns_records,
            "dnssec":        dnssec,
            "analytics":     analytics,
            "http_security": http_security,
            "period": {
                "start": start_str,
                "end": end_str,
                "frequency": frequency,
            },
        }
