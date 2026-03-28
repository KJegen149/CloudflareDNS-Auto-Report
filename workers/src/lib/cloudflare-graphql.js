/**
 * Cloudflare API client for Workers runtime.
 *
 * Uses the GraphQL Analytics API for DNS metrics and the REST API for
 * zone info, DNS records, and DNSSEC status.
 */

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';

/** Six grouped analytics queries in one GraphQL round-trip using aliases. */
const DNS_ANALYTICS_QUERY = `
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
`;

/**
 * HTTP traffic overview and security events.
 * Only available for zones with Cloudflare proxy (orange-cloud records).
 * firewallEventsAdaptiveGroups uses datetime (ISO 8601) filters.
 */
const HTTP_SECURITY_QUERY = `
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
`;

/**
 * Cloudflare Gateway / ZTNA analytics.
 * Account-scoped — requires Account Analytics: Read permission.
 * Returns empty object if Gateway is not configured or permission is missing.
 */
const GATEWAY_QUERY = `
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
      gwHttpByCategory: gatewayL7RequestsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { categoryName }
      }
      gwHttpByApp: gatewayL7RequestsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { applicationName }
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
`;

/** Known AI crawlers detected by user-agent substring. Available on all plans. */
const AI_BOTS = [
  { alias: 'gptBot',         name: 'GPTBot (OpenAI)',               ua: 'GPTBot' },
  { alias: 'chatGptUser',    name: 'ChatGPT-User (OpenAI)',         ua: 'ChatGPT-User' },
  { alias: 'googleExtended', name: 'Google-Extended',               ua: 'Google-Extended' },
  { alias: 'claudeBot',      name: 'ClaudeBot (Anthropic)',         ua: 'anthropic-ai' },
  { alias: 'perplexityBot',  name: 'PerplexityBot',                 ua: 'PerplexityBot' },
  { alias: 'metaBot',        name: 'Meta AI Crawler',               ua: 'meta-externalagent' },
  { alias: 'byteSpider',     name: 'ByteSpider (TikTok/ByteDance)', ua: 'Bytespider' },
  { alias: 'appleBotExt',    name: 'Applebot-Extended (Apple)',     ua: 'Applebot-Extended' },
];

function buildAiCrawlersQuery() {
  const aliases = AI_BOTS.map(({ alias, ua }) =>
    `      ${alias}: httpRequestsAdaptiveGroups(\n` +
    `        limit: 1\n` +
    `        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime,` +
    ` requestSource: "eyeball", userAgent_like: "%${ua}%" }\n` +
    `      ) { count sum { edgeResponseBytes } }`
  ).join('\n');
  return (
    `query AiCrawlers($zoneTag: String!, $startDatetime: Time!, $endDatetime: Time!) {\n` +
    `  viewer {\n` +
    `    zones(filter: { zoneTag: $zoneTag }) {\n` +
    aliases + '\n' +
    `    }\n  }\n}`
  );
}

const AI_CRAWLERS_QUERY = buildAiCrawlersQuery();


export class CloudflareClient {
  constructor(apiToken) {
    this.apiToken = apiToken;
    this.headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    };
  }

  async _restGet(path) {
    const resp = await fetch(`${REST_BASE}${path}`, { headers: this.headers });
    if (!resp.ok) throw new Error(`CF REST ${path} failed: ${resp.status}`);
    const data = await resp.json();
    if (!data.success) throw new Error(`CF API error on ${path}: ${JSON.stringify(data.errors)}`);
    return data.result;
  }

  /** Zone metadata (name, status, plan, nameservers). */
  async getZoneInfo(zoneId) {
    return this._restGet(`/zones/${zoneId}`);
  }

  /** All DNS records, paginated. */
  async getDnsRecords(zoneId) {
    const records = [];
    let page = 1;
    while (true) {
      const resp = await fetch(
        `${REST_BASE}/zones/${zoneId}/dns_records?page=${page}&per_page=100&order=type`,
        { headers: this.headers }
      );
      if (!resp.ok) throw new Error(`DNS records fetch failed: ${resp.status}`);
      const data = await resp.json();
      if (!data.success) throw new Error(`DNS records API error: ${JSON.stringify(data.errors)}`);
      records.push(...data.result);
      if (page >= (data.result_info?.total_pages ?? 1)) break;
      page++;
    }
    return records;
  }

  /** DNSSEC status. Returns safe default on error. */
  async getDnssecStatus(zoneId) {
    try {
      return await this._restGet(`/zones/${zoneId}/dnssec`);
    } catch (_) {
      return { status: 'unknown' };
    }
  }

  /**
   * DNS analytics from GraphQL.
   * Cloudflare caps zone-level queries at 7 days — wider ranges are
   * automatically chunked and merged.
   * @returns {{ byDate, byQueryType, byResponseCode, byQueryName, byCacheStatus, byColo }}
   */
  async getDnsAnalytics(zoneId, startDate, endDate) {
    const start    = new Date(startDate + 'T00:00:00Z');
    const end      = new Date(endDate   + 'T00:00:00Z');
    const diffDays = Math.round((end - start) / 86_400_000);

    if (diffDays < 7) {
      return this._fetchAnalyticsChunk(zoneId, startDate, endDate);
    }

    // Split into ≤7-day windows and run sequentially (Workers avoids fan-out quota)
    const chunks = [];
    let cur = new Date(start);
    while (cur <= end) {
      const chunkEnd = new Date(cur);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 6);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());
      chunks.push(await this._fetchAnalyticsChunk(zoneId, isoDate(cur), isoDate(chunkEnd)));
      cur = new Date(chunkEnd);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return mergeAnalytics(chunks);
  }

  async _fetchAnalyticsChunk(zoneId, startDate, endDate) {
    const resp = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        query: DNS_ANALYTICS_QUERY,
        variables: { zoneTag: zoneId, startDate, endDate },
      }),
    });
    if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
    const result = await resp.json();
    if (result.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);

    const zones = result?.data?.viewer?.zones ?? [];
    if (!zones.length) {
      return { byDate: [], byQueryType: [], byResponseCode: [], byQueryName: [], byCacheStatus: [], byColo: [] };
    }
    return zones[0];
  }

  /**
   * HTTP traffic overview and security event counts.
   * Returns empty object for DNS-only (gray-cloud) zones — callers treat as optional.
   * @returns {{ byCountry, httpTotals, securityByAction }}
   */
  async getHttpSecurityData(zoneId, startDate, endDate) {
    try {
      const resp = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          query: HTTP_SECURITY_QUERY,
          variables: {
            zoneTag:       zoneId,
            startDate,
            endDate,
            startDatetime: `${startDate}T00:00:00Z`,
            endDatetime:   `${endDate}T23:59:59Z`,
          },
        }),
      });
      if (!resp.ok) return {};
      const result = await resp.json();
      if (result.errors?.length) return {};
      const zones = result?.data?.viewer?.zones ?? [];
      return zones[0] ?? {};
    } catch (_) {
      return {};
    }
  }

  /**
   * Cloudflare Gateway / ZTNA analytics (account-scoped).
   * Returns empty object if Gateway is not configured or permission is missing.
   * @returns {Promise<object>}
   */
  async getGatewayData(accountId, startDate, endDate) {
    if (!accountId) return {};
    try {
      const resp = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          query: GATEWAY_QUERY,
          variables: {
            accountTag:    accountId,
            startDatetime: `${startDate}T00:00:00Z`,
            endDatetime:   `${endDate}T23:59:59Z`,
          },
        }),
      });
      if (!resp.ok) return {};
      const result = await resp.json();
      if (result.errors?.length) return {};
      const accounts = result?.data?.viewer?.accounts ?? [];
      return accounts[0] ?? {};
    } catch (_) {
      return {};
    }
  }

  /**
   * AI / bot crawler traffic for the zone, one row per known crawler.
   * Works on all Cloudflare plans (uses userAgent_like, not Bot Management).
   * @returns {Promise<Array<{name: string, count: number, bytes: number}>>}
   */
  async getAiTrafficData(zoneId, startDate, endDate) {
    try {
      const resp = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          query: AI_CRAWLERS_QUERY,
          variables: {
            zoneTag:       zoneId,
            startDatetime: `${startDate}T00:00:00Z`,
            endDatetime:   `${endDate}T23:59:59Z`,
          },
        }),
      });
      if (!resp.ok) return [];
      const result = await resp.json();
      if (result.errors?.length) return [];
      const zones = result?.data?.viewer?.zones ?? [];
      if (!zones.length) return [];
      const data = zones[0];
      const rows = [];
      for (const { alias, name } of AI_BOTS) {
        const botRows = data[alias] ?? [];
        if (botRows.length) {
          const count = botRows[0].count ?? 0;
          const bytes = botRows[0].sum?.edgeResponseBytes ?? 0;
          if (count > 0) rows.push({ name, count, bytes });
        }
      }
      return rows.sort((a, b) => b.count - a.count);
    } catch (_) {
      return [];
    }
  }

  /**
   * Collect all data needed to render a report for one zone.
   * @param {string} zoneId
   * @param {'daily'|'weekly'|'monthly'} frequency
   * @param {number|null} lookbackOverrideDays
   */
  async collectReportData(zoneId, frequency, lookbackOverrideDays = null) {
    const { start, end } = computeDateRange(frequency, lookbackOverrideDays);

    const [zoneInfo, dnsRecords, dnssec, analytics, httpSecurity] = await Promise.all([
      this.getZoneInfo(zoneId),
      this.getDnsRecords(zoneId),
      this.getDnssecStatus(zoneId),
      this.getDnsAnalytics(zoneId, start, end),
      this.getHttpSecurityData(zoneId, start, end),
    ]);

    const accountId = zoneInfo?.account?.id ?? '';
    const [gateway, aiTraffic] = await Promise.all([
      this.getGatewayData(accountId, start, end),
      this.getAiTrafficData(zoneId, start, end),
    ]);

    return {
      zoneInfo,
      accountId,
      dnsRecords,
      dnssec,
      analytics,
      http_security: httpSecurity,
      gateway,
      ai_traffic:    aiTraffic,
      period: { start, end, frequency },
    };
  }
}

/** Compute ISO date strings for the report window. */
function computeDateRange(frequency, lookbackOverrideDays) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  if (lookbackOverrideDays) {
    const start = new Date(yesterday);
    start.setUTCDate(start.getUTCDate() - lookbackOverrideDays + 1);
    return { start: isoDate(start), end: isoDate(yesterday) };
  }

  if (frequency === 'daily') {
    return { start: isoDate(yesterday), end: isoDate(yesterday) };
  }

  if (frequency === 'weekly') {
    const start = new Date(yesterday);
    start.setUTCDate(start.getUTCDate() - 6);
    return { start: isoDate(start), end: isoDate(yesterday) };
  }

  // monthly → previous calendar month
  const firstOfThisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastOfPrevMonth  = new Date(firstOfThisMonth);
  lastOfPrevMonth.setUTCDate(0);
  const firstOfPrevMonth = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1));
  return { start: isoDate(firstOfPrevMonth), end: isoDate(lastOfPrevMonth) };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Merge multiple weekly analytics chunks into one combined result. */
function mergeAnalytics(chunks) {
  const byDate  = [];
  const byType  = {};
  const byCode  = {};
  const byName  = {};
  const byCache = {};
  const byColo  = {};

  for (const chunk of chunks) {
    byDate.push(...(chunk.byDate ?? []));

    for (const row of chunk.byQueryType    ?? []) byType [row.dimensions.queryType]      = (byType [row.dimensions.queryType]      ?? 0) + row.count;
    for (const row of chunk.byResponseCode ?? []) byCode [row.dimensions.responseCode]   = (byCode [row.dimensions.responseCode]   ?? 0) + row.count;
    for (const row of chunk.byQueryName    ?? []) byName [row.dimensions.queryName]      = (byName [row.dimensions.queryName]      ?? 0) + row.count;
    for (const row of chunk.byCacheStatus  ?? []) byCache[row.dimensions.responseCached] = (byCache[row.dimensions.responseCached] ?? 0) + row.count;
    for (const row of chunk.byColo         ?? []) byColo [row.dimensions.coloName]       = (byColo [row.dimensions.coloName]       ?? 0) + row.count;
  }

  const toRows = (agg, dimKey, limit) =>
    Object.entries(agg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, v]) => ({ dimensions: { [dimKey]: k }, count: v }));

  return {
    byDate,
    byQueryType:    toRows(byType,  'queryType',      20),
    byResponseCode: toRows(byCode,  'responseCode',   20),
    byQueryName:    toRows(byName,  'queryName',      15),
    byCacheStatus:  toRows(byCache, 'responseCached',  5),
    byColo:         toRows(byColo,  'coloName',       10),
  };
}
