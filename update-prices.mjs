// update-prices.mjs — Runs on GitHub Actions to fetch latest prices
import { readFileSync, writeFileSync } from 'fs';

// Stock definitions
const TW_STOCKS = {
  "元大台灣50": "0050.TW",
  "富邦台50": "006208.TW",
  "元大S&P500": "00646.TW",
  "富邦NASDAQ": "00662.TW",
  "元大台灣50正2": "00631L.TW"
};

const US_STOCKS = {
  "Palantir": "PLTR",
  "Invesco QQQ": "QQQ",
  "Tesla": "TSLA",
  "Vanguard VTI": "VTI",
  "Vanguard VXUS": "VXUS",
  "Nvidia": "NVDA",
  "Vanguard VOO": "VOO",
  "永豐 TLT": "TLT",
  "永豐 VTI": "VTI",
  "永豐 VXUS": "VXUS",
  "國泰 DRAM": "DRAM",
  "國泰 QQQ": "QQQ",
  "國泰 VXUS": "VXUS"
};

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No data');
  return meta.regularMarketPrice || meta.fulldayPrice || meta.chartPreviousClose;
}

async function fetchFXRate() {
  const resp = await fetch('https://rate.bot.com.tw/xrt/flcsv/0/day', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  for (const line of lines) {
    if (line.includes('USD') && line.includes('即期')) {
      const cols = line.split(',');
      if (cols.length >= 2) {
        const rate = parseFloat(cols[1]);
        if (rate > 0) return rate;
      }
    }
  }
  throw new Error('USD rate not found');
}

async function main() {
  // Load existing prices as fallback
  let existing;
  try {
    existing = JSON.parse(readFileSync('prices.json', 'utf8'));
  } catch {
    existing = { prices: {}, fxRate: 31.76 };
  }

  const prices = { ...existing.prices };
  let fxRate = existing.fxRate;
  let updated = 0;

  // Fetch TW stocks
  const twEntries = Object.entries(TW_STOCKS);
  const twResults = await Promise.allSettled(
    twEntries.map(async ([name, symbol]) => {
      const price = await fetchYahoo(symbol);
      if (price > 0) { prices[name] = price; updated++; }
    })
  );
  twResults.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`TW ${twEntries[i][1]} failed:`, r.reason?.message);
  });

  // Fetch US stocks (deduplicated)
  const usEntries = Object.entries(US_STOCKS);
  const usFetched = new Set();
  const usResults = await Promise.allSettled(
    usEntries.map(async ([name, symbol]) => {
      if (usFetched.has(symbol)) {
        prices[name] = prices[name]; // keep existing price for duplicate tickers
        return;
      }
      const price = await fetchYahoo(symbol);
      if (price > 0) {
        prices[name] = price;
        usFetched.add(symbol);
        updated++;
        // Copy to other holdings with same ticker
        usEntries.forEach(([n, s]) => { if (s === symbol && n !== name) prices[n] = price; });
      }
    })
  );
  usResults.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`US ${usEntries[i][1]} failed:`, r.reason?.message);
  });

  // Fetch FX rate
  try {
    fxRate = await fetchFXRate();
    updated++;
    console.log(`FX rate: ${fxRate}`);
  } catch (e) {
    console.warn('FX rate fetch failed:', e.message);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    prices,
    fxRate
  };

  writeFileSync('prices.json', JSON.stringify(output, null, 2) + '\n');
  console.log(`Updated ${updated} prices. Total: ${Object.keys(prices).length} stocks.`);
}

main().catch(e => { console.error(e); process.exit(1); });
