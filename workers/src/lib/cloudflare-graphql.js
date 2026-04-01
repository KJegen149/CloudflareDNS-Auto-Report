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
      byResponseCodeByDate: dnsAnalyticsAdaptiveGroups(
        limit: 5000
        filter: { date_geq: $startDate, date_leq: $endDate }
        orderBy: [date_ASC]
      ) {
        dimensions { date responseCode }
        count
      }
    }
  }
}
`;

/**
 * HTTP traffic overview — chunked 1 day at a time (plan limit on httpRequestsAdaptiveGroups).
 */
const HTTP_REQUESTS_QUERY = `
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
`;

/**
 * Firewall / security events — datetime range, no per-day plan limit.
 */
const FIREWALL_EVENTS_QUERY = `
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
    }
  }
}
`;

// Note: per-user/per-device breakdown is not available in the Gateway analytics
// adaptive groups API — those datasets only expose aggregate dimensions
// (resolverDecision, queryNameReversed, action). Per-device/per-user data
// requires Cloudflare Logpush configured to a storage destination.

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
    `        filter: { date_geq: $startDate, date_leq: $endDate,` +
    ` userAgent_like: "%${ua}%" }\n` +
    `      ) { count sum { edgeResponseBytes } }`
  ).join('\n');
  return (
    `query AiCrawlers($zoneTag: String!, $startDate: Date!, $endDate: Date!) {\n` +
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
      return { byDate: [], byQueryType: [], byResponseCode: [], byQueryName: [], byCacheStatus: [], byColo: [], byResponseCodeByDate: [] };
    }
    const zone = zones[0];
    return {
      byDate:               zone.byDate               ?? [],
      byQueryType:          zone.byQueryType          ?? [],
      byResponseCode:       zone.byResponseCode       ?? [],
      byQueryName:          zone.byQueryName          ?? [],
      byCacheStatus:        zone.byCacheStatus        ?? [],
      byColo:               zone.byColo               ?? [],
      byResponseCodeByDate: zone.byResponseCodeByDate ?? [],
    };
  }

  /**
   * HTTP traffic overview and security event counts.
   * httpRequestsAdaptiveGroups has a 1-day plan limit so HTTP data is chunked
   * one day at a time and aggregated. Firewall events use a full datetime range.
   * Returns empty object for DNS-only (gray-cloud) zones — callers treat as optional.
   * @returns {Promise<{ byCountry, httpTotals, securityByAction }>}
   */
  async getHttpSecurityData(zoneId, startDate, endDate) {
    try {
      // Iterate one day at a time for httpRequestsAdaptiveGroups
      const days = _dateDayRange(startDate, endDate);
      const byCountry = {};
      let totalVisits = 0;
      let totalBytes  = 0;

      for (const day of days) {
        const resp = await fetch(GRAPHQL_ENDPOINT, {
          method: 'POST', headers: this.headers,
          body: JSON.stringify({
            query: HTTP_REQUESTS_QUERY,
            variables: { zoneTag: zoneId, startDate: day, endDate: day },
          }),
        });
        if (resp.ok) {
          const result = await resp.json();
          if (!result.errors?.length) {
            const z = result?.data?.viewer?.zones?.[0] ?? {};
            for (const row of (z.byCountry ?? [])) {
              const k = row.dimensions.clientCountryName;
              byCountry[k] = (byCountry[k] ?? 0) + row.count;
            }
            const t = z.httpTotals?.[0]?.sum ?? {};
            totalVisits += t.visits            ?? 0;
            totalBytes  += t.edgeResponseBytes ?? 0;
          }
        }
      }

      // Firewall events: full datetime range has no per-day cap
      const securityByAction = {};
      const fwResp = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify({
          query: FIREWALL_EVENTS_QUERY,
          variables: {
            zoneTag:       zoneId,
            startDatetime: `${startDate}T00:00:00Z`,
            endDatetime:   `${endDate}T23:59:59Z`,
          },
        }),
      });
      if (fwResp.ok) {
        const fwResult = await fwResp.json();
        if (!fwResult.errors?.length) {
          for (const row of (fwResult?.data?.viewer?.zones?.[0]?.securityByAction ?? [])) {
            const k = row.dimensions.action;
            securityByAction[k] = (securityByAction[k] ?? 0) + row.count;
          }
        }
      }

      if (!Object.keys(byCountry).length && !totalVisits && !Object.keys(securityByAction).length) {
        return {};
      }

      const toRows = (agg, dimKey, limit) =>
        Object.entries(agg)
          .sort(([,a],[,b]) => b - a)
          .slice(0, limit)
          .map(([k, v]) => ({ dimensions: { [dimKey]: k }, count: v }));

      return {
        byCountry:        toRows(byCountry, 'clientCountryName', 10),
        httpTotals:       [{ sum: { visits: totalVisits, edgeResponseBytes: totalBytes } }],
        securityByAction: toRows(securityByAction, 'action', 10),
      };
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
    const vars = {
      accountTag:    accountId,
      startDatetime: `${startDate}T00:00:00Z`,
      endDatetime:   `${endDate}T23:59:59Z`,
    };

    // ── Core query (known-good fields) ────────────────────────────────────────
    let coreData = {};
    try {
      const resp = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query: GATEWAY_QUERY, variables: vars }),
      });
      if (!resp.ok) {
        console.warn(`getGatewayData HTTP error: ${resp.status} for account ${accountId}`);
        return {};
      }
      const result = await resp.json();
      if (result.errors?.length) {
        console.warn(`getGatewayData GraphQL errors: ${JSON.stringify(result.errors.slice(0, 2))}`);
      }
      const accounts = result?.data?.viewer?.accounts ?? [];
      coreData = accounts[0] ?? {};
      console.log(`getGatewayData core: keys=${JSON.stringify(Object.keys(coreData))}`);
    } catch (err) {
      console.warn(`getGatewayData core error: ${err.message}`);
      return {};
    }

    return coreData;
  }

  /**
   * AI / bot crawler traffic, chunked one day at a time (same plan limit as HTTP requests).
   * Works on all Cloudflare plans (uses userAgent_like, not Bot Management).
   * @returns {Promise<Array<{name: string, count: number, bytes: number}>>}
   */
  async getAiTrafficData(zoneId, startDate, endDate) {
    try {
      const days   = _dateDayRange(startDate, endDate);
      const totals = Object.fromEntries(AI_BOTS.map(({ alias }) => [alias, { count: 0, bytes: 0 }]));
      const byDay  = {};

      for (const day of days) {
        const resp = await fetch(GRAPHQL_ENDPOINT, {
          method: 'POST', headers: this.headers,
          body: JSON.stringify({
            query: AI_CRAWLERS_QUERY,
            variables: { zoneTag: zoneId, startDate: day, endDate: day },
          }),
        });
        if (resp.ok) {
          const result = await resp.json();
          if (!result.errors?.length) {
            const data = result?.data?.viewer?.zones?.[0] ?? {};
            let dayTotal = 0;
            for (const { alias } of AI_BOTS) {
              const botRows = data[alias] ?? [];
              if (botRows.length) {
                const c = botRows[0].count ?? 0;
                totals[alias].count += c;
                totals[alias].bytes += botRows[0].sum?.edgeResponseBytes ?? 0;
                dayTotal += c;
              }
            }
            if (dayTotal > 0) byDay[day] = (byDay[day] ?? 0) + dayTotal;
          }
        }
      }

      const rows = [];
      for (const { alias, name } of AI_BOTS) {
        if (totals[alias].count > 0) {
          rows.push({ name, count: totals[alias].count, bytes: totals[alias].bytes });
        }
      }
      return {
        rows: rows.sort((a, b) => b.count - a.count),
        byDay: Object.entries(byDay)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([date, count]) => ({ date, count })),
      };
    } catch (_) {
      return { rows: [], byDay: [] };
    }
  }

  /**
   * Per-user Gateway activity via Log Explorer SQL API.
   * Requires: Logs Read + Zero Trust PII permissions on the API token,
   * and gateway_dns / gateway_http datasets enabled in Log Explorer.
   * Returns empty object silently if Log Explorer is not enabled.
   */
  async getGatewayUserData(accountId, startDate, endDate) {
    if (!accountId) return {};

    const base = `${REST_BASE}/accounts/${accountId}/logs/explorer/query/sql`;
    const run  = async (sql) => {
      const resp = await fetch(`${base}?query=${encodeURIComponent(sql)}`, { headers: this.headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.success) throw new Error(JSON.stringify(data.errors?.slice(0, 1)));
      return data.result ?? [];
    };

    try {
      const [dnsUsers, httpUsers, blockedUsers] = await Promise.all([
        run(`SELECT Email, COUNT(*) AS queries FROM gateway_dns WHERE Date >= '${startDate}' AND Date <= '${endDate}' AND Email != '' GROUP BY Email ORDER BY queries DESC LIMIT 10`),
        run(`SELECT Email, COUNT(*) AS requests FROM gateway_http WHERE Date >= '${startDate}' AND Date <= '${endDate}' AND Email != '' GROUP BY Email ORDER BY requests DESC LIMIT 10`),
        run(`SELECT Email, COUNT(*) AS blocked FROM gateway_dns WHERE Date >= '${startDate}' AND Date <= '${endDate}' AND Email != '' AND Action = 'block' GROUP BY Email ORDER BY blocked DESC LIMIT 10`),
      ]);
      console.log(`getGatewayUserData: dns=${dnsUsers.length} http=${httpUsers.length} blocked=${blockedUsers.length}`);
      return { gwUserDns: dnsUsers, gwUserHttp: httpUsers, gwUserBlocked: blockedUsers };
    } catch (err) {
      console.warn(`getGatewayUserData error: ${err.message}`);
      return {};
    }
  }

  /**
   * Collect all data needed to render a report for one zone.
   * @param {string} zoneId
   * @param {'daily'|'weekly'|'monthly'} frequency
   * @param {number|null} lookbackOverrideDays
   * @param {{ dns?: boolean, ztna?: boolean }} options
   */
  async collectReportData(zoneId, frequency, lookbackOverrideDays = null, options = {}) {
    const { start, end } = computeDateRange(frequency, lookbackOverrideDays);

    const [zoneInfo, dnsRecords, dnssec, analytics, httpSecurity] = await Promise.all([
      this.getZoneInfo(zoneId),
      this.getDnsRecords(zoneId),
      this.getDnssecStatus(zoneId),
      this.getDnsAnalytics(zoneId, start, end),
      this.getHttpSecurityData(zoneId, start, end),
    ]);

    // Filter top queried names to only web-facing records:
    // A records, AAAA records, and Cloudflare Tunnel CNAMEs (*.cfargotunnel.com)
    const webNames = new Set(
      dnsRecords
        .filter(r =>
          r.type === 'A' ||
          r.type === 'AAAA' ||
          (r.type === 'CNAME' && (r.content ?? '').includes('cfargotunnel.com')),
        )
        .map(r => (r.name ?? '').replace(/\.$/, '').toLowerCase()),
    );
    if (webNames.size > 0) {
      const filtered = (analytics.byQueryName ?? []).filter(
        row => webNames.has((row.dimensions.queryName ?? '').replace(/\.$/, '').toLowerCase()),
      );
      if (filtered.length > 0) analytics.byQueryName = filtered;
    }

    const accountId = zoneInfo?.account?.id ?? '';
    const skipZtna  = options.ztna === false;
    const [gateway, gatewayUsers, aiTraffic] = await Promise.all([
      skipZtna ? Promise.resolve({}) : this.getGatewayData(accountId, start, end),
      skipZtna ? Promise.resolve({}) : this.getGatewayUserData(accountId, start, end),
      this.getAiTrafficData(zoneId, start, end),
    ]);

    return {
      zoneInfo,
      accountId,
      dnsRecords,
      dnssec,
      analytics,
      http_security:   httpSecurity,
      gateway:         { ...gateway, ...gatewayUsers },
      ai_traffic:      aiTraffic,
      period:          { start, end, frequency },
      options:         { dns: options.dns !== false, ztna: options.ztna !== false },
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

/**
 * Return an array of ISO date strings (YYYY-MM-DD) for every day in [startDate, endDate].
 * Used to chunk queries that have a 1-day plan limit.
 */
function _dateDayRange(startDate, endDate) {
  const days = [];
  const cur  = new Date(startDate + 'T00:00:00Z');
  const end  = new Date(endDate   + 'T00:00:00Z');
  while (cur <= end) {
    days.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** Merge multiple weekly analytics chunks into one combined result. */
function mergeAnalytics(chunks) {
  const byDate     = [];
  const byType     = {};
  const byCode     = {};
  const byName     = {};
  const byCache    = {};
  const byColo     = {};
  const byRCByDate = {};

  for (const chunk of chunks) {
    byDate.push(...(chunk.byDate ?? []));

    for (const row of chunk.byQueryType          ?? []) byType [row.dimensions.queryType]      = (byType [row.dimensions.queryType]      ?? 0) + row.count;
    for (const row of chunk.byResponseCode       ?? []) byCode [row.dimensions.responseCode]   = (byCode [row.dimensions.responseCode]   ?? 0) + row.count;
    for (const row of chunk.byQueryName          ?? []) byName [row.dimensions.queryName]      = (byName [row.dimensions.queryName]      ?? 0) + row.count;
    for (const row of chunk.byCacheStatus        ?? []) byCache[row.dimensions.responseCached] = (byCache[row.dimensions.responseCached] ?? 0) + row.count;
    for (const row of chunk.byColo               ?? []) byColo [row.dimensions.coloName]       = (byColo [row.dimensions.coloName]       ?? 0) + row.count;
    for (const row of chunk.byResponseCodeByDate ?? []) {
      const key = `${row.dimensions.date}:${row.dimensions.responseCode}`;
      if (!byRCByDate[key]) byRCByDate[key] = { dimensions: { date: row.dimensions.date, responseCode: row.dimensions.responseCode }, count: 0 };
      byRCByDate[key].count += row.count;
    }
  }

  const toRows = (agg, dimKey, limit) =>
    Object.entries(agg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, v]) => ({ dimensions: { [dimKey]: k }, count: v }));

  return {
    byDate,
    byQueryType:          toRows(byType,  'queryType',      20),
    byResponseCode:       toRows(byCode,  'responseCode',   20),
    byQueryName:          toRows(byName,  'queryName',      15),
    byCacheStatus:        toRows(byCache, 'responseCached',  5),
    byColo:               toRows(byColo,  'coloName',       10),
    byResponseCodeByDate: Object.values(byRCByDate)
      .sort((a, b) => (a.dimensions.date < b.dimensions.date ? -1 : a.dimensions.date > b.dimensions.date ? 1 : 0)),
  };
}
