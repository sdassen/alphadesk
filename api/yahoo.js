export default async function handler(req, res) {
  const { symbol, endpoint, from, to } = req.query;

  if (!symbol) return res.status(400).json({ error: "Missing symbol" });

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
  };

  try {
    let url;

    if (endpoint === "quoteSummary") {
      const modules = "financialData,defaultKeyStatistics,summaryDetail,assetProfile";
      url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
    } else if (endpoint === "history") {
      const period1 = from || Math.floor(Date.now() / 1000) - 120 * 86400;
      const period2 = to || Math.floor(Date.now() / 1000);
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
    } else {
      // Default: current quote
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
    }

    const r = await fetch(url, { headers });
    const data = await r.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=300");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
