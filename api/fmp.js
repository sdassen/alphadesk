// FMP proxy — Financial Modeling Prep
// Free tier: 250 calls/day, key-metrics, ratios, profile endpoints
const FMP_KEY = process.env.FMP_API_KEY;
const BASE = "https://financialmodelingprep.com/api/v3";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { symbol, endpoint } = req.query;
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });
  if (!FMP_KEY) return res.status(500).json({ error: "FMP_API_KEY not configured" });

  // Map endpoint to FMP URL
  const urls = {
    // Key metrics: PE, PEG, EV/EBITDA etc — most reliable
    "key-metrics": `${BASE}/key-metrics/${symbol}?limit=1&apikey=${FMP_KEY}`,
    // Ratios: more metrics including pegRatio
    "ratios": `${BASE}/ratios/${symbol}?limit=1&apikey=${FMP_KEY}`,
    // Ratios TTM: trailing twelve months
    "ratios-ttm": `${BASE}/ratios-ttm/${symbol}?apikey=${FMP_KEY}`,
    // Profile: basic company info + current price
    "profile": `${BASE}/profile/${symbol}?apikey=${FMP_KEY}`,
    // Quote: live price
    "quote": `${BASE}/quote/${symbol}?apikey=${FMP_KEY}`,
  };

  const url = urls[endpoint || "key-metrics"];
  if (!url) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "AlphaDesk/1.0" }
    });
    const data = await r.json();

    // FMP returns arrays — return first element for consistency
    const result = Array.isArray(data) ? data[0] : data;

    // If FMP returns error object, pass it through clearly
    if (result?.["Error Message"]) {
      return res.status(403).json({ error: result["Error Message"], fmpError: true });
    }

    return res.status(200).json({ data: result, symbol: symbol.toUpperCase(), endpoint: endpoint || "key-metrics" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
