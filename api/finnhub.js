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

    // Key metrics from Finnhub's metric endpoint
    // Finnhub provides: peBasicExclExtraTTM, peNormalizedAnnual, pegAnnual, pegQuarterly
    const result = {
      source: "Finnhub",
      // PE ratios
      peTTM: m["peBasicExclExtraTTM"] || null,          // Trailing P/E
      peNormalized: m["peNormalizedAnnual"] || null,     // Normalized P/E
      forwardPE: m["peFwdAnnual"] || null,               // Forward P/E (if available)
      // PEG — Finnhub's own calculation
      pegAnnual: m["pegAnnual"] || null,                 // Annual PEG
      pegQuarterly: m["pegQuarterly"] || null,           // Quarterly PEG
      // EPS
      epsGrowth3Y: m["epsGrowth3Y"] || null,             // 3-year EPS growth
      epsGrowth5Y: m["epsGrowth5Y"] || null,             // 5-year EPS growth
      epsTTM: m["epsTTM"] || null,                       // Trailing EPS
      // Growth
      revenueGrowth3Y: m["revenueGrowth3Y"] || null,
      revenueGrowth5Y: m["revenueGrowth5Y"] || null,
      // Margins
      grossMarginTTM: m["grossMarginTTM"] || null,
      operatingMarginTTM: m["operatingMarginTTM"] || null,
      netMarginTTM: m["netProfitMarginTTM"] || null,
      // Returns
      roeTTM: m["roeTTM"] || null,
      roaTTM: m["roaTTM"] || null,
      roicTTM: m["roicTTM"] || null,
      // Valuation
      evEbitdaTTM: m["currentEv/freeCashFlowTTM"] || null,
      priceToBookTTM: m["pbQuarterly"] || null,
      priceToSalesTTM: m["psTTM"] || null,
      // Price
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
