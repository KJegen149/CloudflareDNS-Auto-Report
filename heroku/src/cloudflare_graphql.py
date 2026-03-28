"""
Cloudflare API client.

Uses the GraphQL Analytics API for DNS query metrics and the REST API for
zone info, DNS records, and DNSSEC status.

GraphQL endpoint: https://api.cloudflare.com/client/v4/graphql
REST base:        https://api.cloudflare.com/client/v4

Useful resources:
  - GraphQL schema explorer: https://graphql.cloudflare.com/explorer
  - DNS analytics docs:      https://developers.cloudflare.com/dns/additional-options/analytics/
  - Gateway analytics docs:  https://developers.cloudflare.com/cloudflare-one/insights/analytics/gateway/
  - AI Crawl Control:        https://developers.cloudflare.com/ai-crawl-control/reference/graphql-api/
  - API token scopes needed: Zone.DNS:Read, Zone.Zone:Read, Zone.Analytics:Read
                             Account.Account Analytics:Read (for Gateway/ZTNA data)
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

# Separate queries for HTTP traffic (1-day plan limit — chunked) and firewall events.
HTTP_REQUESTS_QUERY = """
query HttpRequests($zoneTag: String!, $startDate: Date!, $endDate: Date!) {
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
      }
    }
  }
}
"""

FIREWALL_EVENTS_QUERY = """
query FirewallEvents($zoneTag: String!, $startDatetime: Time!, $endDatetime: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
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

# ── Gateway / ZTNA query ───────────────────────────────────────────────────────
# Account-scoped. Requires "Account Analytics: Read" API token permission.
# Uses datetime (ISO 8601 Time) filters — Gateway datasets do not accept Date filters.
# Returns empty dict gracefully if Gateway/ZTNA is not configured on the account.
GATEWAY_QUERY = """
query GatewayInsights($accountTag: String!, $startDatetime: Time!, $endDatetime: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      gwDnsByDecision: gatewayResolverQueriesAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { resolverDecision }
      }
      gwDnsTopDomains: gatewayResolverQueriesAdaptiveGroups(
        limit: 15
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { queryNameReversed }
      }
      gwHttpByAction: gatewayL7RequestsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { action }
      }
      gwTopBandwidth: gatewayL4SessionsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [sum_bytesIngress_DESC]
      ) {
        sum { bytesIngress bytesEgress }
        dimensions { email }
      }
    }
  }
}
"""

# ── AI crawler detection ───────────────────────────────────────────────────────
# Zone-scoped, available on ALL plans via userAgent_like filter.
# Each entry: (graphql_alias, display_name, user_agent_substring)
_AI_BOTS = [
    ("gptBot",         "GPTBot (OpenAI)",           "GPTBot"),
    ("chatGptUser",    "ChatGPT-User (OpenAI)",      "ChatGPT-User"),
    ("googleExtended", "Google-Extended",            "Google-Extended"),
    ("claudeBot",      "ClaudeBot (Anthropic)",      "anthropic-ai"),
    ("perplexityBot",  "PerplexityBot",              "PerplexityBot"),
    ("metaBot",        "Meta AI Crawler",            "meta-externalagent"),
    ("byteSpider",     "ByteSpider (TikTok/ByteDance)", "Bytespider"),
    ("appleBotExt",    "Applebot-Extended (Apple)", "Applebot-Extended"),
]

def _build_ai_crawlers_query() -> str:
    aliases = "\n".join(
        f'      {alias}: httpRequestsAdaptiveGroups(\n'
        f'        limit: 1\n'
        f'        filter: {{ date_geq: $startDate, date_leq: $endDate,'
        f' userAgent_like: "%{ua}%" }}\n'
        f'      ) {{ count sum {{ edgeResponseBytes }} }}'
        for alias, _, ua in _AI_BOTS
    )
    return (
        "query AiCrawlers($zoneTag: String!, $startDate: Date!, $endDate: Date!) {\n"
        "  viewer {\n"
        "    zones(filter: { zoneTag: $zoneTag }) {\n"
        + aliases + "\n"
        "    }\n"
        "  }\n"
        "}\n"
    )

AI_CRAWLERS_QUERY = _build_ai_crawlers_query()


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

    def get_gateway_data(self, account_id: str, start_date: str, end_date: str) -> dict:
        """
        Fetch Cloudflare Gateway (ZTNA) analytics for the account.

        Requires 'Account Analytics: Read' API token permission.
        Returns empty dict if Gateway is not configured or permission is missing.

        Returns:
            Dict with keys: gwDnsByDecision, gwDnsTopDomains, gwHttpByAction,
                            gwHttpByCategory, gwHttpByApp, gwTopBandwidth
        """
        if not account_id:
            return {}
        start_dt = f"{start_date}T00:00:00Z"
        end_dt   = f"{end_date}T23:59:59Z"
        payload = {
            "query": GATEWAY_QUERY,
            "variables": {
                "accountTag":    account_id,
                "startDatetime": start_dt,
                "endDatetime":   end_dt,
            },
        }
        try:
            resp = self.session.post(GRAPHQL_ENDPOINT, json=payload, timeout=self.timeout)
            resp.raise_for_status()
            result = resp.json()
            if result.get("errors"):
                logger.info(
                    "Gateway data unavailable for account %s (Zero Trust may not be active): %s",
                    account_id, result["errors"],
                )
                return {}
            accounts = result.get("data", {}).get("viewer", {}).get("accounts", [])
            return accounts[0] if accounts else {}
        except Exception as exc:
            logger.info("Gateway query failed for account %s: %s", account_id, exc)
            return {}

    def get_ai_traffic_data(self, zone_id: str, start_date: str, end_date: str) -> list:
        """
        Detect known AI crawlers hitting the zone via user-agent matching.

        httpRequestsAdaptiveGroups has a 1-day plan limit on Free/Pro zones.
        Iterates one day at a time and accumulates totals.

        Works on all Cloudflare plans — no Bot Management required.
        Returns a list of {name, count, bytes} dicts sorted by count descending.
        Returns empty list on any error.
        """
        try:
            start = date.fromisoformat(start_date)
            end   = date.fromisoformat(end_date)
            totals: dict = {alias: {"count": 0, "bytes": 0} for alias, _, _ in _AI_BOTS}

            cur = start
            while cur <= end:
                day = cur.isoformat()
                payload = {
                    "query": AI_CRAWLERS_QUERY,
                    "variables": {"zoneTag": zone_id, "startDate": day, "endDate": day},
                }
                resp = self.session.post(GRAPHQL_ENDPOINT, json=payload, timeout=self.timeout)
                if resp.ok:
                    result = resp.json()
                    if not result.get("errors"):
                        zones = result.get("data", {}).get("viewer", {}).get("zones", [])
                        if zones:
                            data = zones[0]
                            for alias, _, _ in _AI_BOTS:
                                bot_rows = data.get(alias, [])
                                if bot_rows:
                                    totals[alias]["count"] += bot_rows[0].get("count", 0)
                                    totals[alias]["bytes"] += bot_rows[0].get("sum", {}).get("edgeResponseBytes", 0)
                cur += timedelta(days=1)

            rows = []
            for alias, display_name, _ in _AI_BOTS:
                c = totals[alias]["count"]
                b = totals[alias]["bytes"]
                if c > 0:
                    rows.append({"name": display_name, "count": c, "bytes": b})
            return sorted(rows, key=lambda x: -x["count"])
        except Exception as exc:
            logger.info("AI traffic query failed for zone %s: %s", zone_id, exc)
            return []

    def get_http_security_data(self, zone_id: str, start_date: str, end_date: str) -> dict:
        """
        Fetch HTTP traffic overview and security event counts via GraphQL.

        httpRequestsAdaptiveGroups has a 1-day plan limit on Free/Pro zones so
        HTTP request data is fetched one day at a time and aggregated.
        Firewall events use a datetime range and can span the full period.

        Only available for zones with Cloudflare proxy enabled (orange-cloud).
        Returns an empty dict on any error so callers can treat it as optional.

        Returns:
            Dict with keys: byCountry, httpTotals, securityByAction
        """
        try:
            start = date.fromisoformat(start_date)
            end   = date.fromisoformat(end_date)

            # --- Chunk HTTP requests one day at a time ---
            by_country:  dict = {}
            total_visits = 0
            total_bytes  = 0

            cur = start
            while cur <= end:
                day = cur.isoformat()
                payload = {
                    "query": HTTP_REQUESTS_QUERY,
                    "variables": {"zoneTag": zone_id, "startDate": day, "endDate": day},
                }
                resp = self.session.post(GRAPHQL_ENDPOINT, json=payload, timeout=self.timeout)
                if resp.ok:
                    result = resp.json()
                    if not result.get("errors"):
                        zones = result.get("data", {}).get("viewer", {}).get("zones", [])
                        if zones:
                            z = zones[0]
                            for row in z.get("byCountry", []):
                                k = row["dimensions"]["clientCountryName"]
                                by_country[k] = by_country.get(k, 0) + row["count"]
                            totals_rows = z.get("httpTotals", [])
                            if totals_rows:
                                s = totals_rows[0].get("sum", {})
                                total_visits += s.get("visits", 0)
                                total_bytes  += s.get("edgeResponseBytes", 0)
                cur += timedelta(days=1)

            # --- Firewall events: full datetime range (no per-zone day limit) ---
            security_by_action: dict = {}
            fw_payload = {
                "query": FIREWALL_EVENTS_QUERY,
                "variables": {
                    "zoneTag":       zone_id,
                    "startDatetime": f"{start_date}T00:00:00Z",
                    "endDatetime":   f"{end_date}T23:59:59Z",
                },
            }
            fw_resp = self.session.post(GRAPHQL_ENDPOINT, json=fw_payload, timeout=self.timeout)
            if fw_resp.ok:
                fw_result = fw_resp.json()
                if not fw_result.get("errors"):
                    fw_zones = fw_result.get("data", {}).get("viewer", {}).get("zones", [])
                    if fw_zones:
                        for row in fw_zones[0].get("securityByAction", []):
                            k = row["dimensions"]["action"]
                            security_by_action[k] = security_by_action.get(k, 0) + row["count"]

            if not (by_country or total_visits or security_by_action):
                return {}

            def _to_rows(agg: dict, dim_key: str, limit: int) -> list:
                return [
                    {"dimensions": {dim_key: k}, "count": v}
                    for k, v in sorted(agg.items(), key=lambda x: -x[1])
                ][:limit]

            return {
                "byCountry":       _to_rows(by_country, "clientCountryName", 10),
                "httpTotals":      [{"sum": {"visits": total_visits, "edgeResponseBytes": total_bytes}}],
                "securityByAction": _to_rows(security_by_action, "action", 10),
            }
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
        account_id   = zone_info.get("account", {}).get("id", "")
        dns_records  = self.get_dns_records(zone_id)
        dnssec       = self.get_dnssec_status(zone_id)
        analytics    = self.get_dns_analytics(zone_id, start_str, end_str)
        http_security = self.get_http_security_data(zone_id, start_str, end_str)
        ai_traffic   = self.get_ai_traffic_data(zone_id, start_str, end_str)
        gateway      = self.get_gateway_data(account_id, start_str, end_str)

        return {
            "zone_info":     zone_info,
            "account_id":    account_id,
            "dns_records":   dns_records,
            "dnssec":        dnssec,
            "analytics":     analytics,
            "http_security": http_security,
            "ai_traffic":    ai_traffic,
            "gateway":       gateway,
            "period": {
                "start": start_str,
                "end": end_str,
                "frequency": frequency,
            },
        }
