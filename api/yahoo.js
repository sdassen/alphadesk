// Yahoo Finance requires a crumb + cookie for quoteSummary endpoints
// This proxy handles the crumb fetch automatically server-side

let cachedCrumb = null;
let cachedCookie = null;
let crumbFetchedAt = 0;
const CRUMB_TTL = 60 * 60 * 1000; // 1 hour

async function getCrumb() {
  const now = Date.now();
  if (cachedCrumb && cachedCookie && now - crumbFetchedAt < CRUMB_TTL) {
    return { crumb: cachedCrumb, cookie: cachedCookie };
  }

  // Step 1: Get cookie
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    redirect: "follow",
  });
  const cookie = cookieRes.headers.get("set-cookie") || "";

  // Step 2: Get crumb using the cookie
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Cookie": cookie,
    },
  });
  const crumb = await crumbRes.text();

  if (crumb && crumb !== "Invalid Crumb") {
    cachedCrumb = crumb;
    cachedCookie = cookie;
    crumbFetchedAt = now;
  }

  return { crumb, cookie };
}

export default async function handler(req, res) {
  const { symbol, endpoint, from, to } = req.query;

  if (!symbol) return res.status(400).json({ error: "Missing symbol" });

  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
  };

  try {
    let url;
    let headers = { ...baseHeaders };

    if (endpoint === "quoteSummary") {
      const { crumb, cookie } = await getCrumb();
      const modules = "financialData,defaultKeyStatistics,summaryDetail,assetProfile";
      url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
      headers["Cookie"] = cookie;
    } else if (endpoint === "history") {
      const period1 = from || Math.floor(Date.now() / 1000) - 120 * 86400;
      const period2 = to || Math.floor(Date.now() / 1000);
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
    } else {
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