// Market sentiment proxy — VIX, Fear & Greed, S&P500, 10yr yield, DXY, Put/Call
export default async function handler(req, res) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
  };

  try {
    const [vixData, spData, yieldData, dxyData, fearGreedData] = await Promise.allSettled([
      // VIX
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", { headers }),
      // S&P 500
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=5d", { headers }),
      // 10yr Treasury yield
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=1d", { headers }),
      // DXY (USD index)
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=1d", { headers }),
      // Fear & Greed — CNN API
      fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers: { ...headers, "Referer": "https://www.cnn.com/" } }),
    ]);

    const parseYahoo = async (result) => {
      if (result.status !== "fulfilled") return null;
      const json = await result.value.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const quotes = json?.chart?.result?.[0]?.indicators?.quote?.[0];
      const timestamps = json?.chart?.result?.[0]?.timestamp || [];
      return { meta, quotes, timestamps };
    };

    const vix = await parseYahoo(vixData);
    const sp = await parseYahoo(spData);
    const tnx = await parseYahoo(yieldData);
    const dxy = await parseYahoo(dxyData);

    // Fear & Greed
    let fearGreed = null;
    if (fearGreedData.status === "fulfilled") {
      try {
        const fg = await fearGreedData.value.json();
        fearGreed = {
          score: Math.round(fg?.fear_and_greed?.score || fg?.score || 0),
          rating: fg?.fear_and_greed?.rating || fg?.rating || "unknown",
        };
      } catch {}
    }

    // S&P historical closes for YTD and 52w context
    const spCloses = sp?.quotes?.close?.filter(Boolean) || [];
    const spTimestamps = sp?.timestamps || [];
    const spHistory = spTimestamps.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().split("T")[0],
      close: spCloses[i],
    })).filter(d => d.close);

    const result = {
      vix: vix?.meta?.regularMarketPrice || null,
      vixChange: vix?.meta?.regularMarketPrice && vix?.meta?.chartPreviousClose
        ? ((vix.meta.regularMarketPrice - vix.meta.chartPreviousClose) / vix.meta.chartPreviousClose) * 100
        : null,
      sp500: sp?.meta?.regularMarketPrice || null,
      sp500Change: sp?.meta?.regularMarketPrice && sp?.meta?.chartPreviousClose
        ? ((sp.meta.regularMarketPrice - sp.meta.chartPreviousClose) / sp.meta.chartPreviousClose) * 100
        : null,
      sp500History: spHistory.slice(-5),
      treasury10y: tnx?.meta?.regularMarketPrice || null,
      treasury10yChange: tnx?.meta?.regularMarketPrice && tnx?.meta?.chartPreviousClose
        ? tnx.meta.regularMarketPrice - tnx.meta.chartPreviousClose
        : null,
      dxy: dxy?.meta?.regularMarketPrice || null,
      dxyChange: dxy?.meta?.regularMarketPrice && dxy?.meta?.chartPreviousClose
        ? ((dxy.meta.regularMarketPrice - dxy.meta.chartPreviousClose) / dxy.meta.chartPreviousClose) * 100
        : null,
      fearGreed,
    };

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=300"); // 5 min cache
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
