#!/usr/bin/env node
/**
 * Rebuilds fundamentals.json from the STOCK_UNIVERSE symbol list.
 * Fetches /stock/metric and /stock/profile2 from Finnhub for each symbol.
 * Rate limit: 60 calls/min per key. We use CONCURRENCY=5 symbols at a time
 * (10 calls/batch) with a 10-second gap → exactly 60 calls/min.
 * Runtime: ~757 symbols / 5 per batch × 10s ≈ 25 minutes.
 *
 * Required env var: FINNHUB_KEY
 */

const fs   = require('fs');
const path = require('path');

const API_KEY    = process.env.FINNHUB_KEY;
const BASE       = 'https://finnhub.io/api/v1';
const CONCURRENCY = 5;
const BATCH_DELAY = 10_000;

if (!API_KEY) { console.error('FINNHUB_KEY not set'); process.exit(1); }

const SYMBOLS = JSON.parse(fs.readFileSync(path.join(__dirname, '../symbols.json'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(endpoint, params) {
  const q   = new URLSearchParams({ ...params, token: API_KEY });
  const url = `${BASE}${endpoint}?${q}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) return null;
  return res.json();
}

async function fetchSymbol(sym) {
  try {
    const [metric, profile] = await Promise.all([
      get('/stock/metric', { symbol: sym, metric: 'all' }),
      get('/stock/profile2', { symbol: sym }),
    ]);
    const m = metric?.metric ?? {};
    return {
      symbol:             sym,
      name:               profile?.name               ?? sym,
      sector:             profile?.finnhubIndustry    ?? '—',
      trailingPE:         m.peBasicExclExtraTTM       ?? m.peTTM                      ?? null,
      priceToBook:        m.pbAnnual                  ?? m.pbQuarterly                ?? null,
      evEbitda:           m.evEbitdaAnnual            ?? m.evEbitdaTTM                ?? null,
      grossMargin:        m.grossMarginTTM            ?? m.grossMarginAnnual          ?? null,
      revenueGrowth:      m.revenueGrowthTTMAnnual    ?? null,
      fcfYield:           m.fcfYieldTTM               ?? null,
      marketCap:          m.marketCapitalization != null && m.marketCapitalization * 1e6 <= 20_000_000_000_000
                            ? m.marketCapitalization * 1e6 : null,
      week52High:         m['52WeekHigh']             ?? null,
      week52Low:          m['52WeekLow']              ?? null,
      divGrowth:          m.dividendGrowthRate5Y               ?? null,
      divYield:           m.dividendYieldIndicatedAnnual       ?? null,
      epsTTM:             m.epsTTM                             ?? m.epsNormalizedAnnual ?? null,
      debtEquity:         m['totalDebt/totalEquityAnnual']     ?? m['totalDebt/totalEquityQuarterly'] ?? null,
      sharesOutstanding:  m.sharesOutstanding ?? m.shareFloat  ?? null,
    };
  } catch (e) {
    if (e.message === 'RATE_LIMIT') throw e;
    console.warn(`  skip ${sym}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`Building cache for ${SYMBOLS.length} symbols...`);
  const data = {};
  let done = 0;

  for (let i = 0; i < SYMBOLS.length; i += CONCURRENCY) {
    const batch   = SYMBOLS.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(fetchSymbol));

    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === 'rejected' && r.reason?.message === 'RATE_LIMIT') {
        console.error('Rate limit hit — increase BATCH_DELAY or reduce CONCURRENCY');
        process.exit(1);
      }
      if (r.status === 'fulfilled' && r.value) {
        data[batch[j]] = r.value;
      }
      done++;
    }

    const pct = Math.round((done / SYMBOLS.length) * 100);
    console.log(`  ${done}/${SYMBOLS.length} (${pct}%) — last batch: ${batch.join(', ')}`);

    if (i + CONCURRENCY < SYMBOLS.length) await sleep(BATCH_DELAY);
  }

  const out = { ts: Date.now(), data };
  fs.writeFileSync(path.join(__dirname, '../fundamentals.json'), JSON.stringify(out));
  console.log(`Done. ${Object.keys(data).length} symbols written to fundamentals.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
