/**
 * Cloudflare API client for Workers runtime.
 *
 * Uses the GraphQL Analytics API for DNS metrics and the REST API for
 * zone info, DNS records, and DNSSEC status.
 */

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';

/** Five grouped analytics queries in one GraphQL round-trip using aliases. */
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
    }
  }
}
`;

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
   * @returns {{ byDate, byQueryType, byResponseCode, byQueryName, byCacheStatus }}
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
      return { byDate: [], byQueryType: [], byResponseCode: [], byQueryName: [], byCacheStatus: [] };
    }
    return zones[0];
  }

  /**
   * Collect all data needed to render a report for one zone.
   * @param {string} zoneId
   * @param {'daily'|'weekly'|'monthly'} frequency
   * @param {number|null} lookbackOverrideDays
   */
  async collectReportData(zoneId, frequency, lookbackOverrideDays = null) {
    const { start, end } = computeDateRange(frequency, lookbackOverrideDays);

    const [zoneInfo, dnsRecords, dnssec, analytics] = await Promise.all([
      this.getZoneInfo(zoneId),
      this.getDnsRecords(zoneId),
      this.getDnssecStatus(zoneId),
      this.getDnsAnalytics(zoneId, start, end),
    ]);

    return { zoneInfo, dnsRecords, dnssec, analytics, period: { start, end, frequency } };
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

  for (const chunk of chunks) {
    byDate.push(...(chunk.byDate ?? []));

    for (const row of chunk.byQueryType    ?? []) byType [row.dimensions.queryType]     = (byType [row.dimensions.queryType]     ?? 0) + row.count;
    for (const row of chunk.byResponseCode ?? []) byCode [row.dimensions.responseCode]  = (byCode [row.dimensions.responseCode]  ?? 0) + row.count;
    for (const row of chunk.byQueryName    ?? []) byName [row.dimensions.queryName]     = (byName [row.dimensions.queryName]     ?? 0) + row.count;
    for (const row of chunk.byCacheStatus  ?? []) byCache[row.dimensions.responseCached] = (byCache[row.dimensions.responseCached] ?? 0) + row.count;
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
  };
}
