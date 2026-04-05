// Finnhub proxy — free tier: 60 calls/min, basic fundamentals
// Endpoint: /api/finnhub?symbol=POWL
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const BASE = "https://finnhub.io/api/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });
  if (!FINNHUB_KEY) return res.status(500).json({ error: "FINNHUB_API_KEY not configured" });

  try {
    // Fetch basic financials and quote in parallel
    const [finRes, quoteRes] = await Promise.all([
      fetch(`${BASE}/stock/metric?symbol=${symbol}&metric=all&token=${FINNHUB_KEY}`),
      fetch(`${BASE}/quote?symbol=${symbol}&token=${FINNHUB_KEY}`),
    ]);

    const fin = await finRes.json();
    const quote = await quoteRes.json();

    if (fin.error) return res.status(403).json({ error: fin.error });

    const m = fin.metric || {};

    // PE ratios — post-split Finnhub data is already adjusted
    const peTTM = m["peBasicExclExtraTTM"] || null;
    const peNormalized = m["peNormalizedAnnual"] || null;
    const epsGrowth3Y = m["epsGrowth3Y"] || null;    // 3yr CAGR — most stable
    const epsGrowth5Y = m["epsGrowth5Y"] || null;    // 5yr CAGR
    const epsGrowthTTM = m["epsGrowthTTMYoy"] || null;

    // Calculate PEG ourselves — prefer 3Y CAGR (smooths cycles) over 1Y forward
    // Cap extreme growth to avoid misleadingly low PEG numbers
    let calcPeg = null;
    let calcPegSource = null;
    const effectivePE = peTTM || peNormalized;

    if (effectivePE && epsGrowth3Y && epsGrowth3Y > 0) {
      const growthCapped = Math.min(epsGrowth3Y, 100);
      calcPeg = parseFloat((effectivePE / growthCapped).toFixed(2));
      calcPegSource = "3Y CAGR";
    } else if (effectivePE && epsGrowth5Y && epsGrowth5Y > 0) {
      const growthCapped = Math.min(epsGrowth5Y, 100);
      calcPeg = parseFloat((effectivePE / growthCapped).toFixed(2));
      calcPegSource = "5Y CAGR";
    } else if (effectivePE && epsGrowthTTM && epsGrowthTTM > 0) {
      calcPeg = parseFloat((effectivePE / Math.min(epsGrowthTTM, 100)).toFixed(2));
      calcPegSource = "TTM";
    } else if (effectivePE && m["revenueGrowth3Y"] && m["revenueGrowth3Y"] > 0) {
      // Fallback: use revenue growth when EPS history unavailable (e.g. post-acquisition amortization)
      const revGrowthCapped = Math.min(m["revenueGrowth3Y"], 100);
      calcPeg = parseFloat((effectivePE / revGrowthCapped).toFixed(2));
      calcPegSource = "rev3Y~"; // ~ indicates approximation
    } else if (effectivePE && m["revenueGrowth5Y"] && m["revenueGrowth5Y"] > 0) {
      const revGrowthCapped = Math.min(m["revenueGrowth5Y"], 100);
      calcPeg = parseFloat((effectivePE / revGrowthCapped).toFixed(2));
      calcPegSource = "rev5Y~";
    }

    const result = {
      source: "Finnhub",
      peTTM,
      peNormalized,
      pegAnnual: calcPeg,
      pegSource: calcPegSource,
      epsGrowth3Y,
      epsGrowth5Y,
      epsGrowthTTM,
      epsTTM: m["epsTTM"] || null,
      revenueGrowth3Y: m["revenueGrowth3Y"] || null,
      revenueGrowth5Y: m["revenueGrowth5Y"] || null,
      grossMarginTTM: m["grossMarginTTM"] || null,
      operatingMarginTTM: m["operatingMarginTTM"] || null,
      netMarginTTM: m["netProfitMarginTTM"] || null,
      roeTTM: m["roeTTM"] || null,
      roaTTM: m["roaTTM"] || null,
      roicTTM: m["roicTTM"] || null,
      evEbitdaTTM: m["currentEv/freeCashFlowTTM"] || null,
      priceToBookTTM: m["pbQuarterly"] || null,
      priceToSalesTTM: m["psTTM"] || null,
      currentPrice: quote.c || null,
      dayChange: quote.dp || null,
      week52High: m["52WeekHigh"] || null,
      week52Low: m["52WeekLow"] || null,
      beta: m["beta"] || null,
    };

    return res.status(200).json({ data: result, symbol: symbol.toUpperCase() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}