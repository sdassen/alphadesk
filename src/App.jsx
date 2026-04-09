import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
  ComposedChart, Area,
} from "recharts";

// ── Config ────────────────────────────────────────────────────────────────────
const SB = createClient(
  "https://jnuhyhjwoevoleezshum.supabase.co",
  "sb_publishable_8_2sGbwdbgQmptBsh3iUoQ_Dem-WaKv"
);

// ── Yahoo Finance via serverless proxy ───────────────────────────────────────
async function yahooQuote(symbol) {
  const r = await fetch(`/api/yahoo?symbol=${symbol}`);
  return r.json();
}
async function yahooSummary(symbol) {
  const r = await fetch(`/api/yahoo?symbol=${symbol}&endpoint=quoteSummary`);
  return r.json();
}
async function yahooHistory(symbol, days = 120) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const r = await fetch(`/api/yahoo?symbol=${symbol}&endpoint=history&from=${from}&to=${to}`);
  return r.json();
}

async function fetchQuote(symbol) {
  const data = await yahooQuote(symbol);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return {
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.regularMarketPreviousClose,
    change: meta.regularMarketPrice && meta.regularMarketPreviousClose
      ? ((meta.regularMarketPrice - meta.regularMarketPreviousClose) / meta.regularMarketPreviousClose) * 100
      : 0,
  };
}

async function fetchFull(symbol) {
  const [quoteData, summaryData] = await Promise.all([
    yahooQuote(symbol),
    yahooSummary(symbol),
  ]);

  const meta = quoteData?.chart?.result?.[0]?.meta;
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.regularMarketPreviousClose || meta.chartPreviousClose;
  const change = price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  const fin = summaryData?.quoteSummary?.result?.[0];
  const fd = fin?.financialData || {};
  const ks = fin?.defaultKeyStatistics || {};
  const sd = fin?.summaryDetail || {};
  const ap = fin?.assetProfile || {};

  // ── Yahoo PEG calculation (used as fallback) ──────────────────────────────
  const trailingEps = ks.trailingEps?.raw || null;
  const forwardEps  = ks.forwardEps?.raw  || null;
  const forwardPE   = sd.forwardPE?.raw   || ks.forwardPE?.raw  || null;
  const trailingPE  = sd.trailingPE?.raw  || ks.trailingPE?.raw || null;

  const lastSplitDate  = ks.lastSplitDate?.raw || null;
  const daysSinceSplit = lastSplitDate ? (Date.now() / 1000 - lastSplitDate) / 86400 : 999;
  const recentSplit    = daysSinceSplit < 14;

  const forwardGrowth = trailingEps && forwardEps && trailingEps > 0
    ? (forwardEps - trailingEps) / Math.abs(trailingEps) : null;
  const ttmGrowth = fd.earningsGrowth?.raw || null;
  const qtrGrowth = ks.earningsQuarterlyGrowth?.raw || null;
  const revGrowth = fd.revenueGrowth?.raw || null;
  const trailingDistorted = !trailingPE || trailingPE <= 0 || trailingPE > 100
    || (forwardPE && trailingPE > forwardPE * 2.5);

  let epsGrowthRaw, yahooPegSource, usedPE;
  if (recentSplit) {
    if (forwardPE && forwardGrowth !== null && forwardGrowth > 0) {
      usedPE = forwardPE;
      epsGrowthRaw = forwardGrowth <= 1.0 ? forwardGrowth : Math.sqrt(forwardGrowth);
      yahooPegSource = forwardGrowth <= 1.0 ? "fwd*" : "fwd↓*";
    } else { usedPE = null; epsGrowthRaw = 0; yahooPegSource = "split!"; }
  } else if (trailingDistorted && forwardPE && forwardGrowth !== null && forwardGrowth > 0) {
    usedPE = forwardPE;
    epsGrowthRaw = forwardGrowth <= 1.0 ? forwardGrowth : Math.sqrt(forwardGrowth);
    yahooPegSource = forwardGrowth <= 1.0 ? "fwd" : "fwd↓";
  } else if (forwardGrowth !== null && forwardGrowth > 0 && forwardGrowth <= 1.0) {
    usedPE = trailingPE; epsGrowthRaw = forwardGrowth; yahooPegSource = "fwd";
  } else if (ttmGrowth !== null && ttmGrowth > 0 && ttmGrowth <= 2.0) {
    usedPE = trailingPE; epsGrowthRaw = ttmGrowth; yahooPegSource = "ttm";
  } else if (forwardGrowth !== null && forwardGrowth > 1.0) {
    usedPE = trailingPE; epsGrowthRaw = Math.sqrt(forwardGrowth); yahooPegSource = "fwd↓";
  } else if (qtrGrowth !== null && qtrGrowth > 0) {
    usedPE = trailingPE; epsGrowthRaw = Math.min(qtrGrowth, 2.0); yahooPegSource = "qtr";
  } else {
    usedPE = trailingPE || forwardPE; epsGrowthRaw = revGrowth || 0; yahooPegSource = "rev";
  }

  const epsGrowthPct = epsGrowthRaw * 100;
  const effectivePE  = usedPE || forwardPE;
  const yahooPeg = (yahooPegSource === "split!" || !effectivePE || epsGrowthPct <= 0)
    ? null : effectivePE / epsGrowthPct;

  // ── Other Yahoo metrics ───────────────────────────────────────────────────
  const grossMargin    = (fd.grossMargins?.raw    || 0) * 100;
  const operatingMargin = (fd.operatingMargins?.raw || 0) * 100;
  const roic           = (fd.returnOnEquity?.raw  || 0) * 100;
  const fcf            = fd.freeCashflow?.raw || null;
  const revenue        = fd.totalRevenue?.raw || null;
  const fcfMargin      = fcf && revenue ? (fcf / revenue) * 100 : null;
  const sharesOut      = ks.sharesOutstanding?.raw || null;
  const fcfPerShare    = fcf && sharesOut ? fcf / sharesOut : null;
  const fcfYield       = fcfPerShare && price ? (fcfPerShare / price) * 100 : null;
  const totalDebt      = fd.totalDebt?.raw || 0;
  const totalCash      = fd.totalCash?.raw || 0;
  const ebitda         = fd.ebitda?.raw || 0;
  const netDebtEbitda  = ebitda > 0 ? (totalDebt - totalCash) / ebitda : null;
  const enterpriseValue = ks.enterpriseValue?.raw || null;
  const evEbitda       = enterpriseValue && ebitda > 0 ? enterpriseValue / ebitda : null;
  const shortPct       = ks.shortPercentOfFloat?.raw != null ? ks.shortPercentOfFloat.raw * 100 : null;
  const revenueGrowth  = (fd.revenueGrowth?.raw || 0) * 100;
  const marketCap      = sd.marketCap?.raw || null;

  return {
    symbol: symbol.toUpperCase(),
    name: ap.longName || ap.shortName || symbol,
    price, change,
    pe: effectivePE, forwardPE,
    // Yahoo PEG — kept for comparison/fallback
    yahooPeg, yahooPegSource,
    // These will be overridden by fetchCombined if Finnhub data available
    peg: yahooPeg, pegSource: yahooPegSource,
    evEbitda, epsGrowth: epsGrowthPct, revenueGrowth,
    grossMargin, operatingMargin, roic, fcfMargin, fcfYield,
    netDebtEbitda, shortPct, marketCap,
    sector: ap.sector || "—",
    logo: `https://logo.clearbit.com/${ap.website?.replace(/https?:\/\//, "").split("/")[0]}`,
    currentEpsGrowth: epsGrowthRaw, recentSplit,
    splitFactor: (() => {
      const raw = ks.lastSplitFactor?.raw || ks.lastSplitFactor || null;
      if (!recentSplit || !raw) return 1;
      const parts = String(raw).split(':');
      return parts.length === 2 ? parseFloat(parts[0]) / parseFloat(parts[1]) : 1;
    })(),
  };
}

// ── Combined fetch: both PEGs explicit, no hidden primary ────────────────────
// pegForward  = Yahoo analyst consensus → forward-looking, speculative
// pegHistoric = Finnhub EPS CAGR        → backward-looking, conservative
// Use both together; AI weighs them based on company type
async function fetchCombined(symbol) {
  const [yahooData, fhRaw] = await Promise.all([
    fetchFull(symbol),
    fetchFinnhub(symbol),
  ]);
  if (!yahooData) return null;

  const fh = fhRaw?.error ? null : fhRaw;

  // Forward PEG — Yahoo analyst consensus (forward EPS based)
  // Best for growth companies where future earnings matter more than history
  const pegForward     = yahooData.yahooPeg;
  const pegForwardSrc  = yahooData.yahooPegSource;  // e.g. "fwd", "fwd↓", "ttm"

  // Historic PEG — Finnhub 3Y/5Y EPS CAGR (realized growth)
  // Conservative sanity check — what growth has actually been delivered
  const pegHistoric    = fh?.pegAnnual ?? null;
  const pegHistoricSrc = fh?.pegSource ?? null;     // e.g. "eps3Y", "rev3Y~"

  // Divergence signal — helps identify speculative vs confirmed value
  let pegDivergence = null;
  if (pegForward != null && pegHistoric != null) {
    const diff = Math.abs(pegForward - pegHistoric) / Math.max(pegForward, pegHistoric);
    pegDivergence = {
      pct: Math.round(diff * 100),
      // Low divergence = confirmed value. High = market expects turnaround
      signal: diff < 0.2 ? "confirmed"    // Both agree — high confidence
             : diff < 0.5 ? "moderate"    // Some gap — reasonable
             : pegForward < pegHistoric ? "turnaround" // Forward cheap, history expensive → market bets on growth
             : "rerating",               // Forward expensive, history cheap → maybe priced in
    };
  }

  return {
    ...yahooData,
    // Primary display PEG — use forward if available (it's what investors price in)
    // clearly labelled so user knows what they're looking at
    peg: pegForward ?? pegHistoric,
    pegSource: pegForward != null ? `fwd:${pegForwardSrc}` : `hist:${pegHistoricSrc}`,
    // Both exposed for comparison
    pegForward, pegForwardSrc,
    pegHistoric, pegHistoricSrc,
    pegDivergence,
    // Finnhub extras
    fmp: fh ? { ...fh, source: "Finnhub" } : null,
    epsGrowth3Y: fh?.epsGrowth3Y ?? null,
    epsGrowth5Y: fh?.epsGrowth5Y ?? null,
    fhPeTTM: fh?.peTTM ?? null,
    recentSplit: yahooData.recentSplit,
    splitFactor: yahooData.splitFactor || 1,
  };
}

// ── Finnhub data fetch ────────────────────────────────────────────────────────
async function fetchFinnhub(symbol) {
  try {
    const r = await fetch(`/api/finnhub?symbol=${symbol}`);
    const json = await r.json();
    if (json.error) return { error: json.error };
    return json.data || { error: "No data" };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchHistoricalPrices(symbol, days = 120) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const r = await fetch(`/api/yahoo?symbol=${symbol}&endpoint=history&from=${from}&to=${to}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().split("T")[0],
    close: closes[i],
  })).filter(d => d.close != null);
}

// ── Supabase ──────────────────────────────────────────────────────────────────
const db = {
  async getShortlist() {
    const { data } = await SB.from("shortlist").select("*").order("added_at", { ascending: true });
    return (data || []).map(r => ({
      symbol: r.symbol, target: r.target, thesis: r.thesis,
      status: r.status, addedAt: new Date(r.added_at).getTime()
    }));
  },
  async upsertShortlist(item) {
    await SB.from("shortlist").upsert({
      symbol: item.symbol, target: item.target || null,
      thesis: item.thesis || "", status: item.status || "Watching"
    }, { onConflict: "symbol" });
  },
  async deleteShortlist(symbol) { await SB.from("shortlist").delete().eq("symbol", symbol); },
  async updateShortlistStatus(symbol, status) { await SB.from("shortlist").update({ status }).eq("symbol", symbol); },

  async getPortfolio() {
    const { data } = await SB.from("portfolio").select("*").order("created_at", { ascending: true });
    return (data || []).map(r => ({
      symbol: r.symbol, shares: r.shares, avgCost: r.avg_cost, thesis: r.thesis,
      assetType: r.asset_type || "stock", currency: r.currency || "USD",
      yahooSymbol: r.yahoo_symbol || r.symbol,
    }));
  },
  async upsertPortfolio(pos) {
    await SB.from("portfolio").upsert({
      symbol: pos.symbol, shares: pos.shares,
      avg_cost: pos.avgCost, thesis: pos.thesis || "",
      asset_type: pos.assetType || "stock",
      currency: pos.currency || "USD",
      yahoo_symbol: pos.yahooSymbol || null,
    }, { onConflict: "symbol" });
  },
  async deletePortfolio(symbol) { await SB.from("portfolio").delete().eq("symbol", symbol); },

  async getValuationConfig(symbol) {
    // Try symbol-specific first, then DEFAULT
    const { data } = await SB.from("valuation_config")
      .select("*")
      .in("symbol", [symbol, "DEFAULT"])
      .order("symbol", { ascending: true }); // DEFAULT sorts before symbol names alphabetically... use case
    if (!data?.length) return null;
    return data.find(r => r.symbol === symbol) || data.find(r => r.symbol === "DEFAULT") || null;
  },

  async getGrowthForecast(symbol) {
    // Look up custom forecast: symbol-specific first, then sector, then null (global)
    const { data } = await SB.from("growth_forecasts")
      .select("*")
      .or(`symbol.eq.${symbol},symbol.is.null`)
      .or("valid_until.is.null,valid_until.gte." + new Date().toISOString().split("T")[0])
      .order("symbol", { ascending: false }) // symbol-specific first
      .order("created_at", { ascending: false });
    if (!data?.length) return null;
    // Prefer symbol-specific over sector over global
    return data.find(r => r.symbol === symbol)
      || data.find(r => r.sector === "semiconductor")
      || data[0];
  },
  async saveGrowthForecast(symbol, g1_pct, g2_pct, source, note) {
    await SB.from("growth_forecasts").insert({
      symbol, g1_pct, g2_pct, source: source || "manual", note: note || null
    });
  },
  async getLastRebalance() {
    const { data } = await SB.from("rebalance_log")
      .select("*").eq("type", "rebalance")
      .order("executed_at", { ascending: false }).limit(1);
    return data?.[0] || null;
  },
  async logRebalance(summary, signals, override = false, overrideReason = null) {
    await SB.from("rebalance_log").insert({
      type: "rebalance", summary, signals, override, override_reason: overrideReason
    });
  },
  async savePegSnapshot(symbol, peg, pe, price, epsGrowth) {
    await SB.from("peg_history").upsert({
      symbol, peg, pe, price, eps_growth: epsGrowth,
      date: new Date().toISOString().split("T")[0]
    }, { onConflict: "symbol,date" });
  },

  async getPegHistory(symbol) {
    const { data } = await SB.from("peg_history")
      .select("date,peg,pe,price,eps_growth")
      .eq("symbol", symbol)
      .order("date", { ascending: true });
    return data || [];
  },

  async getAllPegHistory() {
    const { data } = await SB.from("peg_history")
      .select("date,symbol,peg")
      .order("date", { ascending: true });
    return data || [];
  },

  // Bootstrap: insert historical snapshots using price history + current EPS growth as proxy
  async seedHistory(symbol, priceHistory, currentEpsGrowth, currentPE, currentPrice) {
    if (!currentEpsGrowth || !currentPE || !currentPrice) return 0;
    const rows = [];
    for (const day of priceHistory) {
      // Approximate historical P/E by scaling current P/E by price ratio
      const priceRatio = day.close / currentPrice;
      const estPE = currentPE * priceRatio;
      const estPEG = estPE / (currentEpsGrowth * 100);
      if (estPEG > 0 && estPEG < 20) {
        rows.push({
          symbol,
          date: day.date,
          peg: parseFloat(estPEG.toFixed(3)),
          pe: parseFloat(estPE.toFixed(2)),
          price: day.close,
          eps_growth: currentEpsGrowth * 100,
        });
      }
    }
    if (!rows.length) return 0;
    // Insert in batches of 50
    for (let i = 0; i < rows.length; i += 50) {
      await SB.from("peg_history").upsert(rows.slice(i, i + 50), { onConflict: "symbol,date" });
    }
    return rows.length;
  }
};

// ── Utils ─────────────────────────────────────────────────────────────────────
const fmt = {
  price: (v) => v != null ? `$${v.toFixed(2)}` : "—",
  pct: (v) => v != null ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` : "—",
  num: (v) => v != null ? v.toFixed(2) : "—",
};
const pegColor = (peg) => peg == null ? "#888" : peg < 0.8 ? "#00e5a0" : peg < 1.5 ? "#f5c842" : "#ff6b6b";

const SYMBOL_COLORS = {
  ASML: "#00e5a0", TSM: "#f5c842", MU: "#60a5fa",
  MRVL: "#f97316", POWL: "#a78bfa", CLS: "#fb7185",
  NVDA: "#34d399", AMD: "#fbbf24", AMAT: "#818cf8", LRCX: "#e879f9",
};
const getColor = (sym) => SYMBOL_COLORS[sym] || "#888";

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 16 }) => {
  const icons = {
    scan: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M8 11h6"/></svg>,
    star: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    briefcase: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
    chart: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    plus: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
    trash: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>,
    refresh: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
    db: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
    seed: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22V12M12 12C12 7 7 3 2 3c0 5 4 9 10 9zM12 12c0-5 5-9 10-9-1 5-5 9-10 9"/></svg>,
  };
  return icons[name] || null;
};

const Spinner = ({ size = 15 }) => (
  <div style={{ display: "inline-block", width: size, height: size, border: "2px solid #1e1e1e", borderTop: "2px solid #00e5a0", borderRadius: "50%", animation: "spin 0.7s linear infinite" }}/>
);
const Badge = ({ children, color = "#00e5a0" }) => (
  <span style={{ background: color + "22", color, border: `1px solid ${color}44`, borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>{children}</span>
);
const PEGBar = ({ peg, source }) => {
  const isSplit = source === "split!";
  const isPostSplit = source?.includes("*");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 3, background: "#1a1a1a", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: isSplit ? "0%" : `${(Math.min(Math.max(peg || 0, 0), 3) / 3) * 100}%`, height: "100%", background: isSplit ? "#555" : pegColor(peg), borderRadius: 2, transition: "width 0.5s ease" }}/>
      </div>
      {isSplit
        ? <span style={{ color: "#f5c842", fontWeight: 700, fontSize: 11, fontFamily: "monospace" }} title="Recent stock split — data unreliable">split⚠</span>
        : <span style={{ color: pegColor(peg), fontWeight: 700, fontSize: 13, minWidth: 36, textAlign: "right", fontFamily: "monospace" }} title={`Source: ${source || "—"}${isPostSplit ? " (post-split caution)" : ""}`}>
            {fmt.num(peg)}{isPostSplit ? "⚠" : ""}
          </span>
      }
    </div>
  );
};

// ── PEG Chart Tab ─────────────────────────────────────────────────────────────
function PEGChartTab({ portfolioSymbols }) {
  const [allHistory, setAllHistory] = useState({});
  const [selectedSymbols, setSelectedSymbols] = useState([]);
  const [availableSymbols, setAvailableSymbols] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState([]);

  const loadHistory = async () => {
    setLoading(true);
    const raw = await db.getAllPegHistory();
    const bySymbol = {};
    for (const row of raw) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = {};
      bySymbol[row.symbol][row.date] = parseFloat(row.peg?.toFixed(3));
    }
    setAllHistory(bySymbol);
    const syms = Object.keys(bySymbol);
    setAvailableSymbols(syms);
    const toSelect = portfolioSymbols.filter(s => syms.includes(s));
    setSelectedSymbols(toSelect.length ? toSelect : syms.slice(0, 4));
    setLoading(false);
  };

  useEffect(() => { loadHistory(); }, []);

  useEffect(() => {
    if (!Object.keys(allHistory).length || !selectedSymbols.length) { setChartData([]); return; }
    const dateSet = new Set();
    for (const sym of selectedSymbols) {
      if (allHistory[sym]) Object.keys(allHistory[sym]).forEach(d => dateSet.add(d));
    }
    const dates = [...dateSet].sort();
    const data = dates.map(date => {
      const row = { date: date.slice(5) };
      for (const sym of selectedSymbols) {
        if (allHistory[sym]?.[date] != null) row[sym] = allHistory[sym][date];
      }
      return row;
    });
    setChartData(data);
  }, [allHistory, selectedSymbols]);

  const toggleSymbol = (sym) => {
    setSelectedSymbols(p => p.includes(sym) ? p.filter(s => s !== sym) : [...p, sym]);
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace" }}>
        <div style={{ color: "#555", fontSize: 11, marginBottom: 8 }}>{label}</div>
        {payload.map(p => (
          <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 3 }}>
            <span style={{ color: p.color, fontSize: 12 }}>{p.dataKey}</span>
            <span style={{ color: pegColor(p.value), fontWeight: 700, fontSize: 12 }}>{p.value?.toFixed(2)}</span>
          </div>
        ))}
      </div>
    );
  };

  const hasData = chartData.length > 0;

  return (
    <div>
      {/* Controls row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Symbols</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {availableSymbols.map(sym => {
              const active = selectedSymbols.includes(sym);
              const color = getColor(sym);
              return (
                <button key={sym} onClick={() => toggleSymbol(sym)}
                  style={{ background: active ? color + "22" : "#0a0a0a", border: `1px solid ${active ? color + "88" : "#1e1e1e"}`, borderRadius: 6, color: active ? color : "#444", padding: "5px 11px", cursor: "pointer", fontSize: 12, fontFamily: "monospace", fontWeight: active ? 700 : 400, transition: "all 0.15s" }}>
                  {sym}
                </button>
              );
            })}
          </div>
        </div>
        <button onClick={loadHistory} disabled={loading}
          style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: loading ? "#2a2a2a" : "#555", padding: "7px 13px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {loading ? <Spinner/> : <Icon name="refresh" size={13}/>} Refresh
        </button>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        {[["< 0.8", "#00e5a0", "Undervalued"], ["0.8–1.5", "#f5c842", "Fair value"], ["> 1.5", "#ff6b6b", "Expensive"]].map(([range, color, label]) => (
          <div key={range} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: color + "55", border: `1px solid ${color}` }}/>
            <span style={{ fontSize: 11, color: "#555" }}>PEG {range} — {label}</span>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#333", fontFamily: "monospace", padding: "40px 0" }}><Spinner/> Loading history…</div>
      ) : !hasData ? (
        <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", padding: 60, textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 16 }}>📈</div>
          <div style={{ color: "#888", fontFamily: "monospace", fontSize: 14, marginBottom: 12 }}>No PEG history yet</div>
          <div style={{ color: "#444", fontSize: 12, lineHeight: 1.8 }}>
            The chart fills automatically via daily scans.<br/>
            A snapshot is saved every time you run the Scanner.<br/>
            <span style={{ color: "#333" }}>After a few scans, reliable trend lines will appear here.</span>
          </div>
        </div>
      ) : (
        <>
          <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", padding: "24px 20px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#333", marginBottom: 16, fontFamily: "monospace" }}>
              PEG ratio over time · {chartData.length} data points · grows with every scan
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#111" vertical={false}/>
                <XAxis dataKey="date" tick={{ fill: "#333", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                <YAxis tick={{ fill: "#333", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} domain={[0, "auto"]}/>
                <ReferenceLine y={0.8} stroke="#00e5a0" strokeDasharray="4 4" strokeOpacity={0.3}/>
                <ReferenceLine y={1.5} stroke="#f5c842" strokeDasharray="4 4" strokeOpacity={0.3}/>
                <Tooltip content={<CustomTooltip/>}/>
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: "monospace", color: "#444" }}/>
                {selectedSymbols.map(sym => (
                  <Line key={sym} type="monotone" dataKey={sym}
                    stroke={getColor(sym)} strokeWidth={2} dot={false}
                    activeDot={{ r: 4, fill: getColor(sym) }}
                    connectNulls={false}/>
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
            {selectedSymbols.map(sym => {
              const history = allHistory[sym] ? Object.entries(allHistory[sym]).sort() : [];
              const latest = history[history.length - 1];
              const oldest = history[0];
              const currentPeg = latest ? latest[1] : null;
              const firstPeg = oldest ? oldest[1] : null;
              const delta = currentPeg && firstPeg ? currentPeg - firstPeg : null;
              const color = getColor(sym);
              return (
                <div key={sym} style={{ background: "#070707", border: `1px solid ${color}22`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color, marginBottom: 6 }}>{sym}</div>
                  <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: pegColor(currentPeg) }}>{fmt.num(currentPeg)}</div>
                  <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>Current PEG</div>
                  {delta != null && (
                    <div style={{ fontSize: 11, color: delta > 0 ? "#ff6b6b" : "#00e5a0", marginTop: 6, fontFamily: "monospace" }}>
                      {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)} since start
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: "#2a2a2a", marginTop: 2 }}>{history.length} snapshots</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Shortlist Entry Timing Dashboard ─────────────────────────────────────────
function ShortlistTab({ shortlist, setShortlist }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ symbol: "", target: "", thesis: "" });
  const [stocks, setStocks] = useState({});
  const [pegHistory, setPegHistory] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const out = {};
    const pegHist = {};
    for (const item of shortlist) {
      const [d, histData] = await Promise.all([
        fetchCombined(item.symbol),
        db.getPegHistory(item.symbol),
      ]);
      if (d) {
        const sd = await yahooSummary(item.symbol);
        const fin = sd?.quoteSummary?.result?.[0]?.financialData;
        const qd = await yahooQuote(item.symbol);
        const meta = qd?.chart?.result?.[0]?.meta;
        out[item.symbol] = {
          ...d,
          week52High: meta?.fiftyTwoWeekHigh || null,
          week52Low: meta?.fiftyTwoWeekLow || null,
          analystTarget: fin?.targetMeanPrice?.raw || null,
          analystHigh: fin?.targetHighPrice?.raw || null,
          analystLow: fin?.targetLowPrice?.raw || null,
          numAnalysts: fin?.numberOfAnalystOpinions?.raw || null,
          recommendation: fin?.recommendationKey || null,
        };
        if (d.peg) db.savePegSnapshot(item.symbol, d.peg, d.pe, d.price, d.epsGrowth).catch(() => {});
      }
      // PEG history stats
      if (histData.length > 1) {
        const pegs = histData.map(h => h.peg).filter(Boolean);
        pegHist[item.symbol] = {
          min: Math.min(...pegs),
          max: Math.max(...pegs),
          avg: pegs.reduce((a, b) => a + b, 0) / pegs.length,
          count: pegs.length,
          history: histData,
        };
      }
    }
    setStocks(out);
    setPegHistory(pegHist);
    setRefreshing(false);
  }, [shortlist]);

  useEffect(() => { if (shortlist.length) refresh(); }, [shortlist.length]);

  const add = async () => {
    if (!form.symbol) return;
    const entry = { symbol: form.symbol.toUpperCase(), target: parseFloat(form.target) || null, thesis: form.thesis, status: "Watching" };
    await db.upsertShortlist(entry);
    setShortlist(p => p.find(s => s.symbol === entry.symbol) ? p : [...p, { ...entry, addedAt: Date.now() }]);
    setAdding(false); setForm({ symbol: "", target: "", thesis: "" });
  };

  const remove = async (sym) => { await db.deleteShortlist(sym); setShortlist(p => p.filter(s => s.symbol !== sym)); };
  const updateStatus = async (sym, status) => { await db.updateShortlistStatus(sym, status); setShortlist(p => p.map(s => s.symbol === sym ? { ...s, status } : s)); };
  const updateTarget = async (sym, target) => {
    await SB.from("shortlist").update({ target: parseFloat(target) || null }).eq("symbol", sym);
    setShortlist(p => p.map(s => s.symbol === sym ? { ...s, target: parseFloat(target) || null } : s));
  };

  const STATUSES = ["Watching", "Ready to Buy", "Bought", "Exited"];
  const statusColor = { "Watching": "#444", "Ready to Buy": "#f5c842", "Bought": "#00e5a0", "Exited": "#ff6b6b" };
  const recColor = { "strong_buy": "#00e5a0", "buy": "#7be0c0", "hold": "#f5c842", "underperform": "#ff9966", "sell": "#ff6b6b" };

  const calcScore = (s, item) => {
    if (!s) return null;
    let score = 50;
    if (s.week52High && s.week52Low) {
      const pos = (s.price - s.week52Low) / (s.week52High - s.week52Low);
      score -= (pos - 0.5) * 40;
    }
    if (s.analystTarget && s.price) score += Math.min(((s.analystTarget - s.price) / s.price) * 100, 30);
    const peg = s.pegForward ?? s.pegHistoric;
    if (peg) score += peg < 0.8 ? 15 : peg < 1.5 ? 5 : -10;
    if (item.target && s.price <= item.target) score += 20;
    return Math.max(0, Math.min(100, Math.round(score)));
  };

  const scoreLabel = (score) => {
    if (score === null) return ["—", "#444"];
    if (score >= 70) return ["BUY ZONE", "#00e5a0"];
    if (score >= 50) return ["FAIR", "#f5c842"];
    return ["EXPENSIVE", "#ff6b6b"];
  };

  const pegContext = (sym, currentPeg) => {
    const h = pegHistory[sym];
    if (!h || h.count < 3) return null;
    const pct = ((currentPeg - h.min) / (h.max - h.min)) * 100;
    const label = pct < 30 ? "Near low ✓" : pct < 70 ? "Mid range" : "Near high ⚠";
    const color = pct < 30 ? "#00e5a0" : pct < 70 ? "#f5c842" : "#ff6b6b";
    return { pct, label, color, min: h.min, max: h.max, avg: h.avg, count: h.count };
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={{ color: "#444", fontSize: 12, fontFamily: "monospace" }}>{shortlist.length} on watchlist</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refresh} disabled={refreshing}
            style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: refreshing ? "#2a2a2a" : "#555", padding: "8px 13px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {refreshing ? <Spinner/> : <Icon name="refresh" size={13}/>}
          </button>
          <button onClick={() => setAdding(true)}
            style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "8px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
            + Add
          </button>
        </div>
      </div>

      {adding && (
        <div style={{ background: "#070707", border: "1px solid #1e1e1e", borderRadius: 12, padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            {[["Symbol", "symbol", 80], ["Entry $", "target", 90], ["Thesis", "thesis", 200]].map(([label, key, w]) => (
              <div key={key}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                <input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                  style={{ width: w, background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, color: "#d0d0d0", padding: "8px 10px", fontSize: 13, fontFamily: "monospace" }}/>
              </div>
            ))}
            <button onClick={add} style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "8px 14px", fontWeight: 700, cursor: "pointer" }}>Save</button>
            <button onClick={() => setAdding(false)} style={{ background: "transparent", border: "1px solid #1e1e1e", borderRadius: 8, color: "#444", padding: "8px 12px", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {shortlist.length === 0 && !adding && (
        <div style={{ textAlign: "center", padding: 60, color: "#222", fontFamily: "monospace" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>★</div>
          <div>Shortlist empty — add stocks to track</div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {shortlist.map(item => {
          const s = stocks[item.symbol];
          const score = calcScore(s, item);
          const [signalLabel, signalColor] = scoreLabel(score);
          const week52Pct = s?.week52High && s?.week52Low
            ? ((s.price - s.week52Low) / (s.week52High - s.week52Low)) * 100 : null;
          const analystUpside = s?.analystTarget && s?.price
            ? ((s.analystTarget - s.price) / s.price) * 100 : null;
          const atTarget = s && item.target && s.price <= item.target;
          const ctx = (s?.pegForward ?? s?.pegHistoric) != null
            ? pegContext(item.symbol, s.pegForward ?? s.pegHistoric) : null;

          return (
            <div key={item.symbol} style={{ background: "#070707", border: `1px solid ${atTarget ? "#00e5a033" : score >= 70 ? "#00e5a018" : "#141414"}`, borderRadius: 14, overflow: "hidden" }}>

              {/* Top bar */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px 10px" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {s?.logo && <img src={s.logo} alt="" style={{ width: 28, height: 28, borderRadius: 7, objectFit: "contain", background: "#111", padding: 3 }} onError={e => e.target.style.display="none"}/>}
                  <div>
                    <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, color: "#fff" }}>{item.symbol}</div>
                    <div style={{ fontSize: 10, color: "#444", marginTop: 1, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s?.name || "—"}</div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                  <div style={{ background: signalColor + "22", border: `1px solid ${signalColor}44`, borderRadius: 6, padding: "3px 9px", fontSize: 10, fontWeight: 700, color: signalColor, fontFamily: "monospace" }}>
                    {score !== null ? `${score} · ${signalLabel}` : "…"}
                  </div>
                  <select value={item.status} onChange={e => updateStatus(item.symbol, e.target.value)}
                    style={{ background: "#0d0d0d", border: `1px solid ${statusColor[item.status]}33`, borderRadius: 5, color: statusColor[item.status], padding: "3px 7px", fontSize: 10, fontFamily: "monospace", cursor: "pointer" }}>
                    {STATUSES.map(st => <option key={st}>{st}</option>)}
                  </select>
                </div>
              </div>

              {/* Price row */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "0 16px 12px" }}>
                <span style={{ fontFamily: "monospace", fontSize: 24, fontWeight: 700, color: "#e0e0e0" }}>
                  {s ? fmt.price(s.price) : <Spinner/>}
                </span>
                {s && <span style={{ fontFamily: "monospace", fontSize: 12, color: s.change >= 0 ? "#00e5a0" : "#ff6b6b", fontWeight: 600 }}>
                  {fmt.pct(s.change)} today
                </span>}
                {analystUpside !== null && (
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: analystUpside >= 10 ? "#00e5a0" : "#888", marginLeft: "auto" }}>
                    target {analystUpside >= 0 ? "+" : ""}{analystUpside.toFixed(0)}%
                    {s?.recommendation && <span style={{ color: recColor[s.recommendation] || "#888", marginLeft: 6 }}>· {s.recommendation?.replace("_", " ")}</span>}
                  </span>
                )}
              </div>

              {/* 52-week bar */}
              {week52Pct !== null && (
                <div style={{ padding: "0 16px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace" }}>{fmt.price(s.week52Low)}</span>
                    <span style={{ fontSize: 9, color: "#444", fontFamily: "monospace" }}>52W · {week52Pct.toFixed(0)}% of range</span>
                    <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace" }}>{fmt.price(s.week52High)}</span>
                  </div>
                  <div style={{ height: 5, background: "#111", borderRadius: 3, position: "relative" }}>
                    <div style={{ position: "absolute", left: 0, width: `${week52Pct}%`, height: "100%", background: week52Pct < 30 ? "#00e5a0" : week52Pct < 70 ? "#f5c842" : "#ff6b6b", borderRadius: 3 }}/>
                    <div style={{ position: "absolute", left: `${week52Pct}%`, top: -3, width: 2, height: 11, background: "#fff", borderRadius: 1, transform: "translateX(-50%)" }}/>
                    {item.target && s?.week52Low && s?.week52High && (
                      <div style={{ position: "absolute", left: `${Math.max(2, Math.min(98, ((item.target - s.week52Low) / (s.week52High - s.week52Low)) * 100))}%`, top: -6, fontSize: 8, color: "#f5c842", transform: "translateX(-50%)", fontFamily: "monospace" }}>▼</div>
                    )}
                  </div>
                </div>
              )}

              {/* PEG — two perspectives */}
              <div style={{ margin: "0 16px 12px", background: "#0a0a0a", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 9, color: "#333", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>PEG Ratio — Two Perspectives</div>
                <div style={{ display: "flex", gap: 0 }}>
                  {/* Forward PEG */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "#888", marginBottom: 1 }}>Forward</div>
                    <div style={{ fontSize: 8, color: "#2a2a2a", marginBottom: 4 }}>analyst consensus</div>
                    <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: s?.recentSplit ? "#f5c842" : pegColor(s?.pegForward) }}>
                      {s?.recentSplit ? "split⚠" : s?.pegForward != null ? fmt.num(s.pegForward) : "—"}
                    </div>
                    <div style={{ fontSize: 8, color: "#2a2a2a", marginTop: 2 }}>{s?.pegForwardSrc || "—"}</div>
                  </div>
                  <div style={{ width: 1, background: "#1a1a1a", margin: "0 10px" }}/>
                  {/* Historic PEG */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "#888", marginBottom: 1 }}>Historic</div>
                    <div style={{ fontSize: 8, color: "#2a2a2a", marginBottom: 4 }}>realized EPS CAGR</div>
                    <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: pegColor(s?.pegHistoric) }}>
                      {s?.pegHistoric != null ? fmt.num(s.pegHistoric) : "—"}
                    </div>
                    <div style={{ fontSize: 8, color: "#2a2a2a", marginTop: 2 }}>{s?.pegHistoricSrc || "no data"}</div>
                  </div>
                  <div style={{ width: 1, background: "#1a1a1a", margin: "0 10px" }}/>
                  {/* Own history */}
                  <div style={{ flex: 1.3 }}>
                    <div style={{ fontSize: 9, color: "#888", marginBottom: 1 }}>vs Own History</div>
                    <div style={{ fontSize: 8, color: "#2a2a2a", marginBottom: 4 }}>{ctx?.count || 0} snapshots</div>
                    {ctx ? (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: ctx.color }}>{ctx.label}</div>
                        <div style={{ marginTop: 4, height: 3, background: "#1a1a1a", borderRadius: 2, position: "relative" }}>
                          <div style={{ position: "absolute", left: `${Math.max(2, Math.min(96, ctx.pct))}%`, top: -3, width: 2, height: 9, background: ctx.color, borderRadius: 1, transform: "translateX(-50%)" }}/>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                          <span style={{ fontSize: 8, color: "#2a2a2a", fontFamily: "monospace" }}>{fmt.num(ctx.min)}</span>
                          <span style={{ fontSize: 8, color: "#2a2a2a", fontFamily: "monospace" }}>{fmt.num(ctx.avg)}</span>
                          <span style={{ fontSize: 8, color: "#2a2a2a", fontFamily: "monospace" }}>{fmt.num(ctx.max)}</span>
                        </div>
                      </>
                    ) : <div style={{ fontSize: 10, color: "#2a2a2a" }}>building…</div>}
                  </div>
                </div>
                {/* Divergence interpretation */}
                {s?.pegDivergence && (() => {
                  const { signal, pct } = s.pegDivergence;
                  const cfg = {
                    confirmed:  { color: "#00e5a0", text: `✓ Both agree (${pct}% diff) — high confidence` },
                    moderate:   { color: "#f5c842", text: `~ ${pct}% gap between forward and historic` },
                    turnaround: { color: "#f5c842", text: `⚡ Forward cheap, history expensive — market bets on growth acceleration` },
                    rerating:   { color: "#ff6b6b", text: `⚠ Forward expensive vs history — growth may already be priced in` },
                  }[signal] || { color: "#555", text: "" };
                  return <div style={{ marginTop: 8, fontSize: 10, color: cfg.color, lineHeight: 1.5 }}>{cfg.text}</div>;
                })()}
              </div>

              {/* Key metrics 2×2 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "0 16px 12px" }}>
                {[
                  ["fwd P/E", fmt.num(s?.forwardPE), s?.forwardPE < 25 ? "#00e5a0" : s?.forwardPE < 40 ? "#f5c842" : "#ff6b6b"],
                  ["EPS Growth", fmt.pct(s?.epsGrowth), "#888"],
                  ["Gross Margin", fmt.pct(s?.grossMargin), "#888"],
                  ["EPS 3Y CAGR", s?.epsGrowth3Y != null ? fmt.pct(s.epsGrowth3Y) : "—", "#888"],
                ].map(([label, val, color]) => (
                  <div key={label} style={{ background: "#0a0a0a", borderRadius: 7, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#333", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 3 }}>{label}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 600, color }}>{val}</div>
                  </div>
                ))}
              </div>

              {/* Entry target + actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px 14px", borderTop: "1px solid #0e0e0e" }}>
                <span style={{ fontSize: 10, color: "#333", whiteSpace: "nowrap" }}>Entry $</span>
                <input
                  defaultValue={item.target || ""}
                  onBlur={e => updateTarget(item.symbol, e.target.value)}
                  placeholder="target price"
                  style={{ flex: 1, background: "transparent", border: "none", borderBottom: "1px solid #1e1e1e", color: "#f5c842", fontFamily: "monospace", fontSize: 13, padding: "2px 4px", outline: "none" }}/>
                {atTarget && <span style={{ fontSize: 10, color: "#00e5a0", fontWeight: 700 }}>🎯 HIT</span>}
                {item.thesis && <span style={{ fontSize: 10, color: "#2a2a2a", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.thesis}>{item.thesis}</span>}
                <button onClick={() => remove(item.symbol)}
                  style={{ background: "transparent", border: "none", color: "#2a2a2a", cursor: "pointer", padding: 4, marginLeft: "auto" }}
                  onMouseEnter={e => e.currentTarget.style.color = "#ff6b6b"}
                  onMouseLeave={e => e.currentTarget.style.color = "#2a2a2a"}>
                  <Icon name="trash" size={12}/>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
const DEFAULT_POSITIONS = [
  { symbol: "TSM",  shares: 90,  avgCost: 229.997, thesis: "Foundry monopoly — AI wafer ramp thesis" },
  { symbol: "BAC",  shares: 128, avgCost: 52.425,  thesis: "Bank of America — interest rate play" },
  { symbol: "CLS",  shares: 8,   avgCost: 270.41,  thesis: "Celestica — AI infrastructure buildout" },
  { symbol: "LLY",  shares: 6,   avgCost: 899.995, thesis: "Eli Lilly — GLP-1 & obesity drug leader" },
  { symbol: "MRVL", shares: 152, avgCost: 77.715,  thesis: "Marvell — NVIDIA NVLink Fusion re-rating" },
  { symbol: "MU",   shares: 43,  avgCost: 411.090, thesis: "Micron — HBM supercycle, best value pick" },
  { symbol: "POWL", shares: 6,   avgCost: 175.562, thesis: "Powell Industries — data center power" },
];

function PortfolioTab({ positions, setPositions }) {
  const [quotes, setQuotes] = useState({});
  const [fundamentals, setFundamentals] = useState({});
  const [finnhubData, setFinnhubData] = useState({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ symbol: "", shares: "", avgCost: "", thesis: "" });
  const [advice, setAdvice] = useState(null);
  const [loadingAdvice, setLoadingAdvice] = useState(false);
  const [lastRebalance, setLastRebalance] = useState(null);
  const [showOverride, setShowOverride] = useState(false);
  const COOLDOWN_DAYS = 30;
  const [cashAmount, setCashAmount] = useState("");
  const [cashAdvice, setCashAdvice] = useState(null);
  const [loadingCash, setLoadingCash] = useState(false);

  const buildPortfolioData = () => positions.map(p => {
    const q = quotes[p.symbol];
    const f = fundamentals[p.symbol];
    const fh = finnhubData[p.symbol];
    const price = q?.price || p.avgCost;
    const value = p.shares * price;
    const gainPct = ((price - p.avgCost) / p.avgCost) * 100;
    const weight = (value / totalValue) * 100;
    const upside = f?.targetMeanPrice && price ? ((f.targetMeanPrice - price) / price) * 100 : null;

    // Both PEGs explicitly
    const pegForward  = f?.pegForward  ?? null;  // Yahoo analyst consensus (forward-looking)
    const pegHistoric = fh?.pegAnnual  ?? null;  // Finnhub realized CAGR (conservative)

    // 52-week — adjust for recent splits (Yahoo reports pre-split prices for up to 2 weeks)
    const recentSplit = f?.recentSplit || false;
    const splitFactor = recentSplit && f?.splitFactor ? f.splitFactor : 1;
    const week52High = q?.week52High ? q.week52High / splitFactor : null;
    const week52Low  = q?.week52Low  ? q.week52Low  / splitFactor : null;
    const week52Pct  = week52High && week52Low && price
      ? ((price - week52Low) / (week52High - week52Low)) * 100 : null;

    return {
      symbol: p.symbol, thesis: p.thesis, shares: p.shares,
      avgCost: p.avgCost, currentPrice: price?.toFixed(2),
      gainLossPct: gainPct?.toFixed(1), portfolioWeight: weight?.toFixed(1),
      forwardPE: f?.forwardPE?.toFixed(1),
      // Both PEGs with sources
      pegForward:      pegForward?.toFixed(2)  ?? null,
      pegForwardSrc:   f?.pegForwardSrc ?? null,
      pegHistoric:     pegHistoric?.toFixed(2) ?? null,
      pegHistoricSrc:  fh?.pegSource ?? null,
      // Divergence signal
      pegDivergence:   f?.pegDivergence ?? null,
      // 52-week (split-adjusted if needed)
      week52Pct:       week52Pct?.toFixed(0) ?? null,
      week52High:      week52High?.toFixed(2) ?? null,
      week52Low:       week52Low?.toFixed(2)  ?? null,
      recentSplit,
      analystUpside: upside?.toFixed(1), analystRec: f?.recommendation,
      revenueGrowth: f?.revenueGrowth ? (f.revenueGrowth * 100).toFixed(1) : null,
      fhEpsGrowth3Y: fh?.epsGrowth3Y?.toFixed(1) || null,
      fhEpsGrowth5Y: fh?.epsGrowth5Y?.toFixed(1) || null,
      fhRoic: fh?.roicTTM?.toFixed(1) || null,
    };
  });

  const getCashAdvice = async () => {
    const amount = parseFloat(cashAmount);
    if (!amount || amount <= 0) return;
    setLoadingCash(true);
    setCashAdvice(null);
    const portfolioData = buildPortfolioData();
    const prompt = `You are a rational, long-term investment analyst deploying $${amount.toFixed(0)} of new cash.

CURRENT PORTFOLIO (total value $${totalValue.toFixed(0)}):
${portfolioData.map(p => `${p.symbol}: weight ${p.portfolioWeight}%, price $${p.currentPrice}
  PEG forward (analyst consensus): ${p.pegForward || "n/a"} [${p.pegForwardSrc || "—"}] — forward-looking
  PEG historic (realized CAGR):    ${p.pegHistoric || "n/a"} [${p.pegHistoricSrc || "—"}] — conservative
  EPS 3Y: ${p.fhEpsGrowth3Y || "n/a"}% | fwd P/E: ${p.forwardPE} | upside: ${p.analystUpside}%
  52W position: ${p.week52Pct != null ? `${p.week52Pct}% of range${p.recentSplit ? " (split-adjusted)" : ""}` : "n/a"}
  Thesis: ${p.thesis}`).join('\n')}

CASH TO DEPLOY: $${amount.toFixed(0)} (${((amount / totalValue) * 100).toFixed(1)}% of portfolio)

High conviction = both forward AND historic PEG are low + stock near 52W lows.
- Prefer: low forward PEG confirmed by historic PEG + high analyst upside + near 52W low + weight <25%
- Avoid: positions already >25% weight or near 52W highs without strong valuation case
- Split across 1-3 positions max, min $500 per trade (DEGIRO fee: ~€4)
- Specify exact share count at current price

Return ONLY valid JSON:
{"summary":"one sentence strategy","allocations":[{"symbol":"X","amount":1234,"shares":5,"rationale":"cite forward PEG, historic PEG and 52W position in reasoning","conviction":"high or medium"}]}`;

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 4000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const text = data.content?.find(b => b.type === "text")?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      setCashAdvice(JSON.parse(clean));
    } catch (e) {
      console.error("Cash advice error:", e);
      setCashAdvice({ error: `Analysis failed: ${e.message}` });
    }
    setLoadingCash(false);
  };

  const refresh = async () => {
    setLoading(true);
    const qOut = {};
    const fOut = {};
    const fhOut = {};
    for (const p of positions) {
      const ticker = p.yahooSymbol || p.symbol;
      const data = await yahooQuote(ticker);
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) qOut[p.symbol] = {
        price: meta.regularMarketPrice,
        week52High: meta.fiftyTwoWeekHigh,
        week52Low: meta.fiftyTwoWeekLow,
        currency: meta.currency || p.currency || "USD",
      };
      // Only fetch fundamentals for stocks
      if (p.assetType === "stock") {
        try {
          const combined = await fetchCombined(p.symbol);
          if (combined) {
            fOut[p.symbol] = {
              forwardPE:    combined.forwardPE,
              trailingPE:   combined.pe,
              earningsGrowth: combined.epsGrowth / 100,
              grossMargins: combined.grossMargin / 100,
              revenueGrowth: combined.revenueGrowth / 100,
              // Both PEGs with sources and divergence
              pegForward:    combined.pegForward,
              pegForwardSrc: combined.pegForwardSrc,
              pegHistoric:   combined.pegHistoric,
              pegHistoricSrc: combined.pegHistoricSrc,
              pegDivergence: combined.pegDivergence,
              // Split detection
              recentSplit:   combined.recentSplit,
              splitFactor:   combined.splitFactor || 1,
              // Analyst targets fetched below
              targetMeanPrice: null,
              recommendation: null,
            };
            // Fetch analyst targets from Yahoo
            const sd = await yahooSummary(ticker);
            const fin = sd?.quoteSummary?.result?.[0];
            if (fin) {
              fOut[p.symbol].targetMeanPrice = fin.financialData?.targetMeanPrice?.raw || null;
              fOut[p.symbol].recommendation  = fin.financialData?.recommendationKey  || null;
              fOut[p.symbol].forwardEps      = fin.defaultKeyStatistics?.forwardEps?.raw  || null;
              fOut[p.symbol].trailingEps     = fin.defaultKeyStatistics?.trailingEps?.raw || null;
              // Also store split factor from Yahoo for 52w adjustment
              const splitRaw = fin.defaultKeyStatistics?.lastSplitFactor?.raw;
              if (combined.recentSplit && splitRaw) {
                // splitFactor e.g. "3:1" → 3
                const parts = String(splitRaw).split(':');
                fOut[p.symbol].splitFactor = parts.length === 2
                  ? parseFloat(parts[0]) / parseFloat(parts[1]) : 1;
              }
            }
            if (combined.fmp) fhOut[p.symbol] = combined.fmp;
          }
        } catch {}
      }
    }
    setQuotes(qOut);
    setFundamentals(fOut);
    setFinnhubData(fhOut);
    setLoading(false);
  };

  useEffect(() => {
    if (positions.length) refresh();
    db.getLastRebalance().then(setLastRebalance);
  }, [positions.length]);

  const remove = async (sym) => { await db.deletePortfolio(sym); setPositions(p => p.filter(x => x.symbol !== sym)); };

  const add = async () => {
    if (!form.symbol || !form.shares || !form.avgCost) return;
    const pos = { symbol: form.symbol.toUpperCase(), shares: parseFloat(form.shares), avgCost: parseFloat(form.avgCost), thesis: form.thesis };
    await db.upsertPortfolio(pos);
    setPositions(p => [...p.filter(x => x.symbol !== pos.symbol), pos]);
    setAdding(false); setForm({ symbol: "", shares: "", avgCost: "", thesis: "" });
  };

  const totalCost = positions.reduce((s, p) => s + p.shares * p.avgCost, 0);
  const totalValue = positions.reduce((s, p) => s + p.shares * (quotes[p.symbol]?.price || p.avgCost), 0);
  const pnl = totalValue - totalCost;
  const ret = totalCost ? (pnl / totalCost) * 100 : 0;

  // ── Cooldown logic ───────────────────────────────────────────────────────────
  const cooldownStatus = (() => {
    if (!lastRebalance) return { blocked: false, daysLeft: 0, daysAgo: null };
    const lastDate = new Date(lastRebalance.executed_at);
    const daysAgo = Math.floor((Date.now() - lastDate) / 86400000);
    const daysLeft = COOLDOWN_DAYS - daysAgo;
    return { blocked: daysLeft > 0, daysLeft: Math.max(0, daysLeft), daysAgo };
  })();

  // Market stress check — VIX or Fear&Greed extreme → allow override
  const marketStress = (() => {
    // We don't have live market data here, but we can check from the MarketTab context
    // For now, expose override as manual option with confirmation
    return false; // Could be wired to MarktTab data later
  })();

  const getRebalancingAdvice = async (isOverride = false) => {
    if (cooldownStatus.blocked && !isOverride) return;
    setLoadingAdvice(true);
    setAdvice(null);
    setShowOverride(false);
    const portfolioData = buildPortfolioData();

    const prompt = `You are a rational, long-term investment analyst. Your primary rule: DO NOT TRADE unless there is a compelling, data-driven reason.

PORTFOLIO (value $${totalValue.toFixed(0)}, return ${ret.toFixed(1)}%):
${portfolioData.map(p => `${p.symbol}: ${p.shares} shares @ avg $${p.avgCost}, now $${p.currentPrice}, gain ${p.gainLossPct}%, weight ${p.portfolioWeight}%
  PEG forward (analyst consensus): ${p.pegForward || "n/a"} [${p.pegForwardSrc || "—"}] — forward-looking, speculative
  PEG historic (realized CAGR):    ${p.pegHistoric || "n/a"} [${p.pegHistoricSrc || "—"}] — conservative, backward-looking
  EPS growth 3Y: ${p.fhEpsGrowth3Y || "n/a"}% | fwd P/E: ${p.forwardPE} | analyst upside: ${p.analystUpside}% | rec: ${p.analystRec}
  52W position: ${p.week52Pct != null ? `${p.week52Pct}% of range${p.recentSplit ? " (split-adjusted)" : ""}` : "n/a"}`).join('\n')}

PEG INTERPRETATION GUIDE:
- For growth companies (MRVL, MU, TSM): weight forward PEG more — they trade on future earnings
- For mature/cyclical companies: weight historic PEG more — forward estimates are often too optimistic
- When forward << historic: market prices in turnaround — higher risk, higher potential
- When both are low: strongest buy signal — confirmed AND expected cheap
- 52W position <30% = near lows, potential entry; >70% = near highs, caution on adds

STRICT RULES:
- TRIM: weight >20% AND (forward PEG >2.5 OR analyst upside <5%). Otherwise HOLD.
- ADD: analyst upside >25% AND forward PEG <1.5 AND weight <15%. Otherwise HOLD.
- Default to HOLD. A good investor does nothing most of the time.
- Each trade costs ~€4 in DEGIRO fees.

Return ONLY valid JSON:
{"summary":"one sentence assessment","signals":[{"symbol":"X","signal":"TRIM or HOLD or ADD","reason":"data-driven reason citing both PEGs and 52W position","action":"specific action or null if HOLD"}],"rebalance":[{"from":"X","to":"Y","rationale":"brief reason","urgency":"high or medium or low"}]}`;

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 4000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const text = data.content?.find(b => b.type === "text")?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setAdvice(parsed);
      // Log to DB and reset cooldown
      await db.logRebalance(
        parsed.summary, parsed.signals,
        isOverride, isOverride ? "manual override" : null
      );
      const updated = await db.getLastRebalance();
      setLastRebalance(updated);
    } catch (e) {
      console.error("AI analysis error:", e);
      setAdvice({ error: `Analysis failed: ${e.message}` });
    }
    setLoadingAdvice(false);
  };

  const signalColor = { "TRIM": "#ff6b6b", "HOLD": "#f5c842", "ADD": "#00e5a0" };
  const urgencyColor = { "high": "#ff6b6b", "medium": "#f5c842", "low": "#555" };

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 22 }}>
        {[["Value", `$${totalValue.toFixed(0)}`, totalValue >= totalCost ? "#00e5a0" : "#ff6b6b"],
          ["Cost Basis", `$${totalCost.toFixed(0)}`, "#555"],
          ["P&L", `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`, pnl >= 0 ? "#00e5a0" : "#ff6b6b"],
          ["Return", fmt.pct(ret), ret >= 0 ? "#00e5a0" : "#ff6b6b"]].map(([label, val, color]) => (
          <div key={label} style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "14px 18px" }}>
            <div style={{ fontSize: 9, color: "#333", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13, flexWrap: "wrap", gap: 8 }}>
        <span style={{ color: "#444", fontSize: 12, fontFamily: "monospace" }}>{positions.length} positions · DEGIRO</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={refresh} disabled={loading} style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: loading ? "#2a2a2a" : "#555", padding: "7px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {loading ? <Spinner/> : <Icon name="refresh" size={13}/>} Refresh
          </button>
          {/* AI Rebalance — with 30-day cooldown */}
          {cooldownStatus.blocked ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <button
                onClick={() => setShowOverride(v => !v)}
                style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: 8, color: "#444", padding: "7px 14px", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
                title={`Last rebalance: ${cooldownStatus.daysAgo}d ago`}>
                🔒 Rebalance in {cooldownStatus.daysLeft}d
              </button>
              {showOverride && (
                <div style={{ background: "#0d0d0d", border: "1px solid #f5c84233", borderRadius: 8, padding: "10px 14px", fontSize: 11, color: "#f5c842", maxWidth: 240, textAlign: "right" }}>
                  <div style={{ marginBottom: 8, lineHeight: 1.5 }}>Override cooldown? This is meant for exceptional market events only. Last ran {cooldownStatus.daysAgo}d ago.</div>
                  <button onClick={() => getRebalancingAdvice(true)}
                    style={{ background: "#f5c84222", border: "1px solid #f5c84244", borderRadius: 6, color: "#f5c842", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                    {loadingAdvice ? <Spinner/> : "⚡ Override & Run"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button onClick={() => getRebalancingAdvice(false)} disabled={loadingAdvice || loading || !Object.keys(quotes).length}
              style={{ background: loadingAdvice ? "#0a0a0a" : "#0d1a14", border: "1px solid #00e5a033", borderRadius: 8, color: loadingAdvice ? "#2a2a2a" : "#00e5a0", padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
              {loadingAdvice ? <Spinner/> : "✦"} {loadingAdvice ? "Analyzing…" : `AI Rebalance${lastRebalance ? ` (${cooldownStatus.daysAgo}d ago)` : ""}`}
            </button>
          )}
          {/* Cash deployment */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0a0a0a", border: "1px solid #1a2a1a", borderRadius: 8, padding: "4px 4px 4px 12px" }}>
            <span style={{ fontSize: 11, color: "#555", whiteSpace: "nowrap" }}>Deploy $</span>
            <input
              type="number"
              value={cashAmount}
              onChange={e => setCashAmount(e.target.value)}
              placeholder="1000"
              style={{ width: 75, background: "transparent", border: "none", color: "#d0d0d0", fontSize: 13, fontFamily: "monospace", outline: "none" }}
            />
            <button onClick={getCashAdvice} disabled={loadingCash || loading || !Object.keys(quotes).length || !cashAmount}
              style={{ background: loadingCash ? "#111" : "#00e5a0", border: "none", borderRadius: 6, color: loadingCash ? "#333" : "#000", padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
              {loadingCash ? <Spinner/> : "→ Allocate"}
            </button>
          </div>
          <button onClick={() => setAdding(true)} style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
            <Icon name="plus" size={13}/> Position
          </button>
        </div>
      </div>

      {/* Cash deployment advice */}
      {cashAdvice && !cashAdvice.error && (
        <div style={{ background: "#070707", border: "1px solid #00e5a033", borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#00e5a0", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>💵 Deploy ${parseFloat(cashAmount).toFixed(0)} — AI Allocation</div>
            <button onClick={() => setCashAdvice(null)} style={{ background: "transparent", border: "none", color: "#333", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          {cashAdvice.summary && (
            <div style={{ fontSize: 13, color: "#888", marginBottom: 16, lineHeight: 1.6, fontStyle: "italic" }}>"{cashAdvice.summary}"</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cashAdvice.allocations?.map((a, i) => {
              const q = quotes[a.symbol];
              const price = q?.price;
              const newWeight = totalValue > 0 ? (((positions.find(p => p.symbol === a.symbol)?.shares || 0) * (price || 0) + a.amount) / (totalValue + parseFloat(cashAmount))) * 100 : 0;
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "80px 100px 100px 1fr 80px", alignItems: "center", gap: 12, background: "#0a0a0a", borderRadius: 8, padding: "12px 16px", border: `1px solid ${a.conviction === "high" ? "#00e5a033" : "#1a1a1a"}` }}>
                  <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 15, color: "#fff" }}>{a.symbol}</div>
                  <div>
                    <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#00e5a0", fontSize: 14 }}>${a.amount?.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>{a.shares} shares @ {price ? `$${price.toFixed(2)}` : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#444", marginBottom: 2 }}>New weight</div>
                    <div style={{ fontFamily: "monospace", fontSize: 13, color: "#888" }}>{newWeight.toFixed(1)}%</div>
                  </div>
                  <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>{a.rationale}</div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: a.conviction === "high" ? "#00e5a0" : "#f5c842", textTransform: "uppercase" }}>{a.conviction}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Total check */}
          {cashAdvice.allocations && (
            <div style={{ marginTop: 12, fontSize: 11, color: "#444", display: "flex", justifyContent: "space-between" }}>
              <span>Total allocated: ${cashAdvice.allocations.reduce((s, a) => s + (a.amount || 0), 0).toLocaleString()}</span>
              <span style={{ color: "#2a2a2a", fontStyle: "italic" }}>Not financial advice — verify before trading</span>
            </div>
          )}
        </div>
      )}
      {cashAdvice?.error && (
        <div style={{ background: "#0a0a0a", border: "1px solid #ff6b6b22", borderRadius: 8, padding: "12px 16px", marginBottom: 13, fontSize: 12, color: "#ff6b6b" }}>{cashAdvice.error}</div>
      )}

      {/* AI Rebalancing advice */}
      {advice && !advice.error && (
        <div style={{ background: "#070707", border: "1px solid #00e5a022", borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "#00e5a0", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>✦ AI Rebalancing Analysis</div>
            <button onClick={() => setAdvice(null)} style={{ background: "transparent", border: "none", color: "#333", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          {advice.summary && (
            <div style={{ fontSize: 13, color: "#888", marginBottom: 16, lineHeight: 1.6, fontStyle: "italic" }}>"{advice.summary}"</div>
          )}
          {/* Per-stock signals */}
          {advice.signals?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Position signals</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {advice.signals.map((s, i) => (
                  <div key={i} style={{ background: "#0a0a0a", borderRadius: 8, padding: "10px 14px", border: `1px solid ${signalColor[s.signal] || "#222"}22`, flex: "1", minWidth: 200 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#fff" }}>{s.symbol}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: signalColor[s.signal] || "#888", background: (signalColor[s.signal] || "#888") + "22", padding: "2px 7px", borderRadius: 4 }}>{s.signal}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>{s.reason}</div>
                    {s.action && <div style={{ fontSize: 11, color: "#00e5a0", marginTop: 6, fontStyle: "italic" }}>→ {s.action}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Rebalancing moves */}
          {advice.rebalance?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Suggested moves</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {advice.rebalance.map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, background: "#0a0a0a", borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#ff6b6b", fontSize: 13 }}>{r.from}</span>
                      <span style={{ color: "#333" }}>→</span>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#00e5a0", fontSize: 13 }}>{r.to}</span>
                    </div>
                    <div style={{ flex: 1, fontSize: 11, color: "#666", lineHeight: 1.5 }}>{r.rationale}</div>
                    <div style={{ fontSize: 10, color: urgencyColor[r.urgency] || "#555", fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap" }}>{r.urgency}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 10, color: "#2a2a2a", marginTop: 14, fontStyle: "italic" }}>
            This is data-driven analysis, not financial advice. Always verify before trading.
          </div>
        </div>
      )}
      {advice?.error && (
        <div style={{ background: "#0a0a0a", border: "1px solid #ff6b6b22", borderRadius: 8, padding: "12px 16px", marginBottom: 13, fontSize: 12, color: "#ff6b6b" }}>
          {advice.error} — check browser console for details.
        </div>
      )}

      {adding && (
        <div style={{ background: "#070707", border: "1px solid #1e1e1e", borderRadius: 12, padding: 16, marginBottom: 13 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            {[["Symbol", "symbol", 85], ["Shares", "shares", 85], ["Avg $", "avgCost", 95], ["Thesis", "thesis", 270]].map(([label, key, w]) => (
              <div key={key}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                <input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                  style={{ width: w, background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, color: "#d0d0d0", padding: "7px 11px", fontSize: 13, fontFamily: "monospace" }}/>
              </div>
            ))}
            <button onClick={add} style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "7px 16px", fontWeight: 700, cursor: "pointer" }}>Save</button>
            <button onClick={() => setAdding(false)} style={{ background: "transparent", border: "1px solid #1e1e1e", borderRadius: 8, color: "#444", padding: "7px 12px", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Position table */}
      {(() => {
        const stocks = positions.filter(p => p.assetType !== "etf");
        const etfs = positions.filter(p => p.assetType === "etf");

        const renderRow = (p) => {
          const q = quotes[p.symbol];
          const price = q?.price || 0;
          const curr = q?.currency || p.currency || "USD";
          const sym = curr === "EUR" ? "€" : "$";
          const value = p.shares * price;
          const cost = p.shares * p.avgCost;
          const pl = value - cost;
          const rt = cost ? (pl / cost) * 100 : 0;
          const weight = totalValue ? (value / totalValue) * 100 : 0;
          const splitFactor = fundamentals[p.symbol]?.splitFactor || 1;
          const recentSplit = fundamentals[p.symbol]?.recentSplit || false;
          const w52High = q?.week52High ? q.week52High / splitFactor : null;
          const w52Low  = q?.week52Low  ? q.week52Low  / splitFactor : null;
          const week52Pct = w52High && w52Low && price
            ? Math.max(0, Math.min(100, ((price - w52Low) / (w52High - w52Low)) * 100)) : null;

          return (
            <div key={p.symbol} style={{ borderBottom: "1px solid #0c0c0c", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#0b0b0b"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 60px", padding: "12px 20px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#e0e0e0" }}>{p.symbol}</span>
                    {p.assetType === "etf" && <span style={{ fontSize: 9, color: "#555", border: "1px solid #222", borderRadius: 3, padding: "1px 5px" }}>ETF</span>}
                    {curr === "EUR" && <span style={{ fontSize: 9, color: "#444", fontFamily: "monospace" }}>€</span>}
                  </div>
                  {p.thesis && <div style={{ fontSize: 10, color: "#3a3a3a", marginTop: 2, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.thesis}</div>}
                </div>
                <div style={{ fontFamily: "monospace", color: "#666", fontSize: 13 }}>{p.shares}</div>
                <div style={{ fontFamily: "monospace", color: "#666", fontSize: 13 }}>{sym}{p.avgCost.toFixed(2)}</div>
                <div style={{ fontFamily: "monospace", color: "#d0d0d0", fontSize: 13 }}>{price ? `${sym}${price.toFixed(2)}` : <Spinner/>}</div>
                <div style={{ fontFamily: "monospace", color: "#888", fontSize: 13 }}>{value ? `${sym}${value.toFixed(0)}` : "—"}</div>
                <div style={{ fontFamily: "monospace", color: pl >= 0 ? "#00e5a0" : "#ff6b6b", fontSize: 13, fontWeight: 600 }}>{pl ? `${pl >= 0 ? "+" : ""}${sym}${Math.abs(pl).toFixed(0)}` : "—"}</div>
                <div style={{ fontFamily: "monospace", color: rt >= 0 ? "#00e5a0" : "#ff6b6b", fontSize: 13, fontWeight: 600 }}>{rt ? fmt.pct(rt) : "—"}</div>
                <div style={{ fontFamily: "monospace", color: "#666", fontSize: 13 }}>{weight ? `${weight.toFixed(1)}%` : "—"}</div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => remove(p.symbol)} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 6, color: "#444", padding: "5px 7px", cursor: "pointer" }}><Icon name="trash" size={12}/></button>
                </div>
              </div>
              {week52Pct !== null && (
                <div style={{ padding: "0 20px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace", whiteSpace: "nowrap" }}>52W LOW</span>
                  <div style={{ flex: 1, height: 3, background: "#111", borderRadius: 2, position: "relative" }}>
                    <div style={{ width: `${week52Pct}%`, height: "100%", background: week52Pct < 30 ? "#00e5a0" : week52Pct < 70 ? "#f5c842" : "#ff6b6b", borderRadius: 2 }}/>
                    <div style={{ position: "absolute", left: `${week52Pct}%`, top: -2, width: 2, height: 7, background: "#fff", transform: "translateX(-50%)", borderRadius: 1 }}/>
                  </div>
                  <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace", whiteSpace: "nowrap" }}>52W HIGH</span>
                  <span style={{ fontSize: 9, color: week52Pct < 30 ? "#00e5a0" : week52Pct < 70 ? "#f5c842" : "#ff6b6b", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {week52Pct.toFixed(0)}%{recentSplit ? " ⚠split" : ""}
                  </span>
                </div>
              )}
            </div>
          );
        };

        const colHeader = (
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 60px", padding: "10px 20px", borderBottom: "1px solid #141414" }}>
            {["Position", "Shares", "Avg", "Price", "Value", "P&L", "Return", "Weight", ""].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: "monospace", textAlign: i === 8 ? "right" : "left" }}>{h}</div>
            ))}
          </div>
        );

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Stocks */}
            <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", overflow: "hidden" }}>
              <div style={{ padding: "10px 20px", borderBottom: "1px solid #141414", fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2 }}>Stocks</div>
              {colHeader}
              {stocks.map(renderRow)}
            </div>
            {/* ETFs */}
            {etfs.length > 0 && (
              <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", overflow: "hidden" }}>
                <div style={{ padding: "10px 20px", borderBottom: "1px solid #141414", fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2 }}>ETFs</div>
                {colHeader}
                {etfs.map(renderRow)}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ── Valuation Tab ─────────────────────────────────────────────────────────────
// ── Valuation helpers ────────────────────────────────────────────────────────
function ValInputField({ label, value, onChange, placeholder, suffix = "%" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, padding: "5px 10px" }}>
        <input
          type="number" value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ width: 60, background: "transparent", border: "none", color: "#f5c842", fontFamily: "monospace", fontSize: 13, outline: "none" }}
        />
        <span style={{ color: "#333", fontSize: 11 }}>{suffix}</span>
      </div>
    </div>
  );
}

// ── Valuation Tab (v2) ────────────────────────────────────────────────────────
// Two-stage growth model + historical PE range bands + user-editable assumptions
function ValuationTab({ positions, shortlist }) {
  const [selected, setSelected]         = useState(null);
  const [data, setData]                 = useState(null);
  const [loading, setLoading]           = useState(false);
  const [growthYears, setGrowthYears]   = useState(3);
  const [customG1, setCustomG1]         = useState("");   // phase 1 growth override
  const [customG2, setCustomG2]         = useState("");   // terminal growth override
  const [customPE, setCustomPE]         = useState("");   // PE multiple override
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [forecast, setForecast]               = useState(null);
  const [showSaveForm, setShowSaveForm]        = useState(false);
  const [saveNote, setSaveNote]                = useState("");

  // All stock symbols from portfolio + shortlist
  const allSymbols = [...new Set([
    ...positions.filter(p => p.assetType !== "etf").map(p => p.symbol),
    ...shortlist.map(s => s.symbol),
  ])].sort();

  useEffect(() => {
    if (allSymbols.length && !selected) setSelected(allSymbols[0]);
  }, [allSymbols.length]);

  useEffect(() => {
    if (selected) loadData(selected);
  }, [selected]);

  const loadData = async (symbol) => {
    setLoading(true);
    setData(null);
    try {
      const [priceHistory, fhRaw, yahooRaw, customForecast, symConfig] = await Promise.all([
        fetchHistoricalPrices(symbol, 365),
        fetchFinnhub(symbol),
        fetch(`/api/yahoo?symbol=${symbol}&endpoint=quoteSummary&modules=defaultKeyStatistics,summaryDetail,financialData`)
          .then(r => r.json()),
        db.getGrowthForecast(symbol),
        db.getValuationConfig(symbol),
      ]);
      setForecast(customForecast);

      const fin = yahooRaw?.quoteSummary?.result?.[0];
      const fd  = fin?.financialData  || {};
      const ks  = fin?.defaultKeyStatistics || {};
      const sd  = fin?.summaryDetail  || {};
      const fh  = fhRaw?.error ? null : fhRaw;

      const currentPrice = fd.currentPrice?.raw  || sd.regularMarketPrice?.raw || null;
      const trailingEps  = ks.trailingEps?.raw   || null;
      const forwardEps   = ks.forwardEps?.raw    || null;
      const trailingPE   = sd.trailingPE?.raw    || null;
      const forwardPE    = sd.forwardPE?.raw     || ks.forwardPE?.raw || null;
      const targetMean   = fd.targetMeanPrice?.raw || null;
      const targetHigh   = fd.targetHighPrice?.raw || null;
      const targetLow    = fd.targetLowPrice?.raw  || null;
      const numAnalysts  = fd.numberOfAnalystOpinions?.raw || null;

      // ── Growth rates ─────────────────────────────────────────────────────────
      const fwdGrowth1Y = trailingEps && forwardEps && trailingEps > 0
        ? (forwardEps - trailingEps) / Math.abs(trailingEps) : null;
      const epsGrowth3Y = fh?.epsGrowth3Y ? fh.epsGrowth3Y / 100 : null;
      const epsGrowth5Y = fh?.epsGrowth5Y ? fh.epsGrowth5Y / 100 : null;
      const revGrowth3Y = fh?.revenueGrowth3Y ? fh.revenueGrowth3Y / 100 : null;

      // ── Config-driven growth + PE selection ─────────────────────────────────
      // symConfig from Supabase valuation_config table — per-symbol settings
      // customForecast (manual override) always wins over config
      const cfg = symConfig || {
        g1_source: 'finnhub_5y', g1_cap: 30, g2_default: 10,
        pe_method: 'forward', pe_bear_mult: 0.70, pe_base_mult: 1.00, pe_bull_mult: 1.40,
      };
      const ttmGrowthRate = fd.earningsGrowth?.raw || null;

      // Pick growth source based on config
      let rawG1, g1Source;
      const G1_CAP = (cfg.g1_cap || 30) / 100;

      if (cfg.g1_source === 'finnhub_5y' && epsGrowth5Y && epsGrowth5Y > 0) {
        rawG1 = epsGrowth5Y; g1Source = `Finnhub 5Y CAGR (${cfg.stock_type})`;
      } else if (cfg.g1_source === 'finnhub_3y' && epsGrowth3Y && epsGrowth3Y > 0) {
        rawG1 = epsGrowth3Y; g1Source = `Finnhub 3Y CAGR (${cfg.stock_type})`;
      } else if (cfg.g1_source === 'ttm' && ttmGrowthRate && ttmGrowthRate > 0) {
        rawG1 = ttmGrowthRate; g1Source = `Yahoo TTM (${cfg.stock_type})`;
      } else {
        // Fallback cascade: 5Y → 3Y → TTM → fwd → rev → est
        rawG1 = (epsGrowth5Y && epsGrowth5Y > 0) ? epsGrowth5Y
              : (epsGrowth3Y && epsGrowth3Y > 0) ? epsGrowth3Y
              : (ttmGrowthRate && ttmGrowthRate > 0) ? ttmGrowthRate
              : (fwdGrowth1Y && fwdGrowth1Y > 0) ? fwdGrowth1Y
              : (revGrowth3Y && revGrowth3Y > 0) ? revGrowth3Y
              : 0.10;
        g1Source = (epsGrowth5Y > 0) ? "Finnhub 5Y fallback"
                 : (epsGrowth3Y > 0) ? "Finnhub 3Y fallback"
                 : (ttmGrowthRate > 0) ? "Yahoo TTM fallback"
                 : "est 10%";
      }

      // Manual forecast overrides everything
      const forecastG1 = customForecast?.g1_pct ? customForecast.g1_pct / 100 : null;
      const forecastG2 = customForecast?.g2_pct ? customForecast.g2_pct / 100 : null;

      const g1Auto = forecastG1 ?? Math.min(rawG1, G1_CAP);
      const g1Capped = !forecastG1 && rawG1 > G1_CAP;
      if (forecastG1) g1Source = customForecast.source;

      const g2Auto = forecastG2 ?? Math.min(0.18, Math.max(0.05,
        (cfg.g2_default ? cfg.g2_default / 100 : null)
        ?? epsGrowth5Y ?? (epsGrowth3Y ? epsGrowth3Y * 0.55 : 0.08)
      ));
      const g2Source = forecastG2  ? customForecast.source
                     : cfg.g2_default ? `${cfg.stock_type} default`
                     : epsGrowth5Y ? "Finnhub 5Y"
                     : "est";

      // ── EPS + PE: must be consistent pair ────────────────────────────────────
      // eps_basis from config determines starting EPS AND which PE is the anchor.
      // 'forward': start at forwardEps, anchor on forwardPE → band t=0 ≈ current price
      // 'trailing': start at trailingEps, anchor on trailingPE → good for banks/mature
      //
      // Sanity check: base band at t=0 should be within 30% of current price.
      // If not, we auto-switch to the other basis.

      const epsBasis = cfg.eps_basis || 'forward';
      let baseEps, anchorPE, useForwardPEBasis, histPEsCount = 0;

      if (epsBasis === 'trailing' && trailingEps && trailingEps > 0
          && trailingPE && trailingPE > 0 && trailingPE < 80) {
        baseEps   = trailingEps;
        anchorPE  = trailingPE;
        useForwardPEBasis = false;
      } else {
        // Forward basis (default for most stocks)
        // Use forward EPS if available, else derive from price/PE
        baseEps = forwardEps
          || (currentPrice && forwardPE ? currentPrice / forwardPE : null)
          || (trailingEps && trailingEps > 0 ? trailingEps : null);
        anchorPE = forwardPE || trailingPE || 20;
        useForwardPEBasis = true;
      }

      // Sanity check: base band at t=0 should ≈ current price
      // If baseEps × anchorPE is way off, it means data is distorted
      const impliedPrice = baseEps && anchorPE ? baseEps * anchorPE : null;
      const priceRatio = impliedPrice && currentPrice ? impliedPrice / currentPrice : 1;
      // If ratio is >2 or <0.4, there's a mismatch — use price/PE directly
      if (priceRatio > 2.0 || priceRatio < 0.4) {
        // Fallback: derive baseEps directly from current price so band starts at price
        baseEps  = currentPrice && anchorPE ? currentPrice / anchorPE : baseEps;
      }

      // Config multipliers define the bear/base/bull PE range for this stock type
      const peBear = anchorPE * (cfg.pe_bear_mult || 0.70);
      const peBase = anchorPE * (cfg.pe_base_mult || 1.00);
      const peBull = anchorPE * (cfg.pe_bull_mult || 1.40);

      // ── Build bands ───────────────────────────────────────────────────────
      const bands = [];
      const today = new Date();
      const phase1Years = Math.min(growthYears, 3);

      for (let m = 0; m <= growthYears * 12; m++) {
        const date = new Date(today);
        date.setMonth(date.getMonth() + m);
        const years = m / 12;
        let projectedEps = baseEps;
        if (projectedEps) {
          if (years <= phase1Years) {
            projectedEps = baseEps * Math.pow(1 + g1Auto, years);
          } else {
            const p1Eps = baseEps * Math.pow(1 + g1Auto, phase1Years);
            projectedEps = p1Eps * Math.pow(1 + g2Auto, years - phase1Years);
          }
        }
        bands.push({
          date: date.toISOString().split("T")[0],
          bull: projectedEps ? projectedEps * peBull : null,
          base: projectedEps ? projectedEps * peBase : null,
          bear: projectedEps ? projectedEps * peBear : null,
        });
      }

      const histMap = {};
      for (const p of priceHistory) histMap[p.date] = p.close;

      setData({
        symbol, currentPrice,
        trailingEps, forwardEps, baseEps,
        stockType: cfg.stock_type || "generic",
        cfgNote: cfg.note || null,
        epsBasis: epsBasis,
        anchorPE: anchorPE,
        baseEpsSource: epsBasis === 'trailing' ? "trailing EPS"
          : (forwardEps ? "forward EPS" : "derived"),
        g1Auto, g2Auto, g1Source, g2Source, g1Capped, rawG1,
        peBear, peBase, peBull,
        useForwardPEBasis, histPEsCount,
        targetMean, targetHigh, targetLow, numAnalysts,
        priceHistory, bands, histMap, fh,
        fwdGrowth1Y, epsGrowth3Y, epsGrowth5Y, revGrowth3Y,
      });
    } catch (e) {
      setData({ error: e.message });
    }
    setLoading(false);
  };

  // Apply user overrides to growth/PE, then recompute bands
  const effectiveG1 = customG1 !== "" && !isNaN(parseFloat(customG1))
    ? parseFloat(customG1) / 100 : data?.g1Auto ?? 0.10;
  const effectiveG2 = customG2 !== "" && !isNaN(parseFloat(customG2))
    ? parseFloat(customG2) / 100 : data?.g2Auto ?? 0.08;
  const effectivePEBase = customPE !== "" && !isNaN(parseFloat(customPE))
    ? parseFloat(customPE) : data?.peBase ?? 20;
  // Scale bull/bear proportionally from custom base PE
  const effectivePEBear = data
    ? effectivePEBase * (data.peBear / (data.peBase || 1)) : data?.peBear;
  const effectivePEBull = data
    ? effectivePEBase * (data.peBull / (data.peBase || 1)) : data?.peBull;

  // Recompute chart data with overrides applied
  const chartData = useMemo(() => {
    if (!data?.priceHistory || !data?.bands) return [];

    const phase1Years = Math.min(growthYears, 3);
    const baseEps = data.baseEps;

    // Recompute bands with effective values
    const today = new Date();
    const bandMap = {};
    for (let m = 0; m <= growthYears * 12; m++) {
      const date = new Date(today);
      date.setMonth(date.getMonth() + m);
      const dateStr = date.toISOString().split("T")[0];
      const years = m / 12;
      let projectedEps = baseEps;
      if (projectedEps) {
        if (years <= phase1Years) {
          projectedEps = baseEps * Math.pow(1 + effectiveG1, years);
        } else {
          const p1Eps = baseEps * Math.pow(1 + effectiveG1, phase1Years);
          projectedEps = p1Eps * Math.pow(1 + effectiveG2, years - phase1Years);
        }
      }
      bandMap[dateStr] = {
        bull: projectedEps ? projectedEps * effectivePEBull : null,
        base: projectedEps ? projectedEps * effectivePEBase : null,
        bear: projectedEps ? projectedEps * effectivePEBear : null,
      };
    }

    const allDates = new Set([
      ...data.priceHistory.map(p => p.date),
      ...Object.keys(bandMap),
    ]);

    return [...allDates].sort().map(date => {
      const band  = bandMap[date];
      const price = data.histMap[date];
      // Format: "Apr '25" — readable with year context
      const d = new Date(date);
      const fmtDate = d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', "' ");
      return {
        date: fmtDate,
        fullDate: date,
        price: price != null ? parseFloat(price.toFixed(2)) : undefined,
        bull:  band?.bull  != null ? parseFloat(band.bull.toFixed(2))  : undefined,
        base:  band?.base  != null ? parseFloat(band.base.toFixed(2))  : undefined,
        bear:  band?.bear  != null ? parseFloat(band.bear.toFixed(2))  : undefined,
      };
    });
  }, [data, effectiveG1, effectiveG2, effectivePEBase, growthYears]);

  // Valuation zone based on current price vs today's bands
  const todayBands = chartData.find(d => d.fullDate === new Date().toISOString().split("T")[0])
    || chartData.find(d => d.bear != null || d.base != null);
  const cp = data?.currentPrice;
  const valZone = cp && todayBands
    ? cp < (todayBands.bear || 0)  ? { label: "DEEP VALUE",  color: "#00e5a0", desc: "Below bear band — market pricing in pessimism" }
    : cp < (todayBands.base || 0)  ? { label: "BUY ZONE",    color: "#7be0c0", desc: "Between bear and base — attractive entry" }
    : cp < (todayBands.bull || 0)  ? { label: "FAIR VALUE",  color: "#f5c842", desc: "Between base and bull — fairly priced" }
    : { label: "EXPENSIVE",       color: "#ff6b6b", desc: "Above bull band — priced for perfection" }
    : null;

  // Upside to base band at end of projection
  const lastBand = chartData[chartData.length - 1];
  const upsideToBase = cp && lastBand?.base
    ? ((lastBand.base - cp) / cp) * 100 : null;

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const hasPrice = payload.find(p => p.dataKey === "price");
    const hasBand  = payload.find(p => p.dataKey === "base");
    const discount = hasPrice && hasBand
      ? ((hasPrice.value - hasBand.value) / hasBand.value) * 100 : null;
    return (
      <div style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, padding: "10px 14px", fontFamily: "monospace", fontSize: 11, minWidth: 160 }}>
        <div style={{ color: "#444", marginBottom: 6 }}>{label}</div>
        {payload.filter(p => p.value != null).map(p => (
          <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}>
            <span style={{ color: p.color }}>{p.dataKey}</span>
            <span style={{ color: "#e0e0e0", fontWeight: 700 }}>${p.value.toFixed(2)}</span>
          </div>
        ))}
        {discount != null && (
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #1a1a1a", color: discount < 0 ? "#00e5a0" : "#ff6b6b", fontSize: 10 }}>
            {discount < 0 ? `${Math.abs(discount).toFixed(0)}% below base` : `${discount.toFixed(0)}% above base`}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* ── Symbol selector + controls ── */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[...new Set([
            ...positions.filter(p => p.assetType !== "etf").map(p => p.symbol),
            ...shortlist.map(s => s.symbol),
          ])].sort().map(sym => (
            <button key={sym} onClick={() => { setSelected(sym); setCustomG1(""); setCustomG2(""); setCustomPE(""); setShowAssumptions(false); }}
              style={{ background: selected === sym ? "#00e5a022" : "#0a0a0a", border: `1px solid ${selected === sym ? "#00e5a066" : "#1e1e1e"}`, borderRadius: 7, color: selected === sym ? "#00e5a0" : "#555", padding: "6px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 12, fontWeight: selected === sym ? 700 : 400 }}>
              {sym}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#333" }}>Horizon</span>
          {[1, 2, 3, 5].map(y => (
            <button key={y} onClick={() => setGrowthYears(y)}
              style={{ background: growthYears === y ? "#f5c84222" : "#0a0a0a", border: `1px solid ${growthYears === y ? "#f5c84266" : "#1e1e1e"}`, borderRadius: 6, color: growthYears === y ? "#f5c842" : "#555", padding: "5px 10px", cursor: "pointer", fontSize: 11, fontFamily: "monospace" }}>
              {y}Y
            </button>
          ))}
          <button onClick={() => setShowAssumptions(v => !v)}
            style={{ background: showAssumptions ? "#f5c84222" : "#0a0a0a", border: `1px solid ${showAssumptions ? "#f5c84244" : "#1e1e1e"}`, borderRadius: 6, color: showAssumptions ? "#f5c842" : "#555", padding: "5px 12px", cursor: "pointer", fontSize: 11 }}>
            ✎ Assumptions
          </button>
          <button onClick={() => selected && loadData(selected)} disabled={loading}
            style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 6, color: "#555", padding: "5px 10px", cursor: "pointer", fontSize: 11 }}>
            ↻
          </button>
        </div>
      </div>

      {/* ── User assumption overrides ── */}
      {showAssumptions && data && (
        <div style={{ background: "#070707", border: "1px solid #f5c84222", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: "#f5c842", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                ✎ Assumptions — {data.stockType || "generic"} model
              </div>
              {data.cfgNote && <div style={{ fontSize: 9, color: "#2a2a2a", marginTop: 3 }}>{data.cfgNote}</div>}
            </div>
            {forecast && (
              <div style={{ fontSize: 10, background: "#00e5a011", border: "1px solid #00e5a033", borderRadius: 5, padding: "3px 8px", color: "#00e5a0" }}>
                ✓ Custom forecast active: {forecast.source}
                {forecast.note && <span style={{ color: "#444", marginLeft: 6 }}>{forecast.note}</span>}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <ValInputField
              label={`Phase 1 Growth (auto: ${(data.g1Auto * 100).toFixed(1)}% · ${data.g1Source})`}
              value={customG1} onChange={setCustomG1} placeholder={(data.g1Auto * 100).toFixed(1)}
            />
            <ValInputField
              label={`Phase 2 Terminal Growth (auto: ${(data.g2Auto * 100).toFixed(1)}% · ${data.g2Source})`}
              value={customG2} onChange={setCustomG2} placeholder={(data.g2Auto * 100).toFixed(1)}
            />
            <ValInputField
              label={`Base PE Multiple (auto: ${data.peBase.toFixed(1)}× · hist median)`}
              value={customPE} onChange={setCustomPE} placeholder={data.peBase.toFixed(1)} suffix="×"
            />
            <button onClick={() => { setCustomG1(""); setCustomG2(""); setCustomPE(""); }}
              style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: 6, color: "#444", padding: "5px 12px", cursor: "pointer", fontSize: 11, alignSelf: "flex-end" }}>
              Reset
            </button>
            <button onClick={() => setShowSaveForm(v => !v)}
              style={{ background: "#00e5a011", border: "1px solid #00e5a033", borderRadius: 6, color: "#00e5a0", padding: "5px 12px", cursor: "pointer", fontSize: 11, alignSelf: "flex-end" }}>
              💾 Save forecast
            </button>
          </div>
          <div style={{ marginTop: 10, fontSize: 10, color: "#2a2a2a", lineHeight: 1.6 }}>
            Phase 1 = years 1–{Math.min(growthYears, 3)} · Phase 2 = years {Math.min(growthYears, 3)+1}–{growthYears} (terminal normalisation)
            {" "}· PE basis: {data.useForwardPEBasis ? "forward PE (cyclical stock)" : `${data.histPEsCount} historical data points`}
            {" "}· Bear {data.peBear.toFixed(0)}× / Base {data.peBase.toFixed(0)}× / Bull {data.peBull.toFixed(0)}×
          </div>
        </div>
      )}

      {/* Save forecast form */}
      {showSaveForm && showAssumptions && (
        <div style={{ background: "#070707", border: "1px solid #00e5a022", borderRadius: 10, padding: "14px 16px", marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#00e5a0", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            💾 Save as named forecast for {selected}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: 9, color: "#555", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>Source / name</div>
              <input value={saveNote} onChange={e => setSaveNote(e.target.value)}
                placeholder={`e.g. "ASML internal Q1 2026"`}
                style={{ width: 220, background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, color: "#d0d0d0", fontFamily: "monospace", fontSize: 12, padding: "5px 10px", outline: "none" }}/>
            </div>
            <div style={{ fontSize: 10, color: "#444" }}>
              Phase 1: {customG1 || (data.g1Auto * 100).toFixed(1)}%
              {" "}· Phase 2: {customG2 || (data.g2Auto * 100).toFixed(1)}%
            </div>
            <button onClick={async () => {
              const g1 = parseFloat(customG1) || data.g1Auto * 100;
              const g2 = parseFloat(customG2) || data.g2Auto * 100;
              await db.saveGrowthForecast(selected, g1, g2, saveNote || "manual", null);
              const updated = await db.getGrowthForecast(selected);
              setForecast(updated);
              setShowSaveForm(false);
              setSaveNote("");
            }} style={{ background: "#00e5a0", border: "none", borderRadius: 6, color: "#000", padding: "5px 14px", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
              Save
            </button>
            <button onClick={() => setShowSaveForm(false)}
              style={{ background: "transparent", border: "1px solid #1e1e1e", borderRadius: 6, color: "#444", padding: "5px 10px", cursor: "pointer", fontSize: 11 }}>
              Cancel
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: "#2a2a2a" }}>
            Saved forecasts persist across sessions and override auto-detected growth rates.
            You can also insert directly via Supabase: table "growth_forecasts".
          </div>
        </div>
      )}

      {loading && <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={24}/></div>}
      {data?.error && <div style={{ color: "#ff6b6b", fontFamily: "monospace", padding: 20 }}>Error: {data.error}</div>}

      {data && !data.error && !loading && (
        <>
          {/* ── Summary cards ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10, marginBottom: 16 }}>
            {[
              ["Price",         `$${data.currentPrice?.toFixed(2)}`,    valZone?.color || "#888"],
              ["Zone",          valZone?.label || "—",                   valZone?.color || "#888"],
              ["Phase 1 Growth",`${(effectiveG1*100).toFixed(1)}%/yr${data.g1Capped && !customG1 ? " ⚠" : ""}`, customG1 ? "#f5c842" : data.g1Capped ? "#f5c842" : "#888"],
              ["Phase 2 Growth",`${(effectiveG2*100).toFixed(1)}%/yr`,  customG2 ? "#f5c842" : "#555"],
              ["Base PE",       `${effectivePEBase.toFixed(0)}×`,        customPE ? "#f5c842" : "#888"],
              ["Base EPS", data.baseEps ? `$${data.baseEps.toFixed(2)}` : "—", "#888"],
              ["EPS basis", `${data.epsBasis || "fwd"} · PE ${data.anchorPE?.toFixed(0)}×`, "#555"],
              [upsideToBase != null ? `${growthYears}Y Upside (base)` : "Analyst Target",
               upsideToBase != null ? `${upsideToBase >= 0 ? "+" : ""}${upsideToBase.toFixed(0)}%`
                                    : (data.targetMean ? `$${data.targetMean.toFixed(0)}` : "—"),
               upsideToBase > 20 ? "#00e5a0" : upsideToBase > 0 ? "#f5c842" : "#ff6b6b"],
              ["Analysts",      data.numAnalysts ? `${data.numAnalysts} covering` : "—", "#555"],
            ].map(([label, val, color]) => (
              <div key={label} style={{ background: "#070707", border: "1px solid #141414", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 9, color: "#333", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color }}>{val}</div>
              </div>
            ))}
          </div>

          {/* ── Band legend ── */}
          <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 10, padding: "10px 16px", marginBottom: 12, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
            {[
              ["─ ─ Bull", `${effectivePEBull?.toFixed(0)}×`, "#f5c842", `hist 90th pct PE — stock at peak optimism`],
              ["─── Base", `${effectivePEBase?.toFixed(0)}×`, "#888",    `hist median PE — neutral fair value`],
              ["─ ─ Bear", `${effectivePEBear?.toFixed(0)}×`, "#00e5a0", `hist 10th pct PE — stock at max pessimism`],
              ["──── Price", "",                               "#e0e0e0", "actual closing price"],
            ].map(([label, pe, color, desc]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color, fontFamily: "monospace", fontWeight: 700 }}>{label}</span>
                {pe && <span style={{ fontSize: 11, color: "#444" }}>{pe}</span>}
                <span style={{ fontSize: 10, color: "#2a2a2a" }}>— {desc}</span>
              </div>
            ))}
            {(customG1 || customG2 || customPE) && (
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#f5c842" }}>⚠ Custom assumptions active</span>
            )}
          </div>

          {/* ── Chart ── */}
          <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "16px 10px 10px" }}>
            <div style={{ paddingLeft: 10, marginBottom: 3, display: "flex", justifyContent: "space-between", alignItems: "center", paddingRight: 10 }}>
              <span style={{ fontSize: 11, color: "#333", textTransform: "uppercase", letterSpacing: 1 }}>
                {selected} · {growthYears}Y Fair Value · Phase 1: {(effectiveG1*100).toFixed(1)}%/yr → Phase 2: {(effectiveG2*100).toFixed(1)}%/yr
              </span>
              {lastBand?.bull > (cp * 2.5) && (
                <span style={{ fontSize: 9, color: "#2a2a2a" }}>bands clipped at 2.5× price for readability</span>
              )}
            </div>
            <div style={{ fontSize: 10, color: "#2a2a2a", paddingLeft: 10, marginBottom: data.g1Capped && !customG1 ? 6 : 10 }}>
              ← ~1Y price history · today · {growthYears}Y projection →
            </div>
            {data.g1Capped && !customG1 && (
              <div style={{ margin: "0 10px 10px", background: "#f5c84211", border: "1px solid #f5c84233", borderRadius: 6, padding: "6px 12px", fontSize: 10, color: "#f5c842" }}>
                ⚠ Phase 1 growth capped at 60% (raw: {(data.rawG1*100).toFixed(0)}%) — cyclical EPS recovery.
                Use Assumptions to set your own estimate.
              </div>
            )}
            <ResponsiveContainer width="100%" height={400}>
              <ComposedChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0e0e0e"/>
                <XAxis dataKey="date" tick={{ fill: "#2a2a2a", fontSize: 10 }} tickLine={false} interval={Math.floor(chartData.length / 7)} minTickGap={40}/>
                <YAxis tick={{ fill: "#2a2a2a", fontSize: 10 }} tickLine={false}
                  tickFormatter={v => v >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v.toFixed(0)}`}
                  domain={[
                    dataMin => Math.max(0, Math.floor(dataMin * 0.85)),
                    () => {
                      // Cap Y at 2.5× current price — keeps bands visible but not absurd
                      const cap = cp ? cp * 2.5 : undefined;
                      const bandMax = todayBands?.bull ? todayBands.bull * 1.8 : undefined;
                      return cap && bandMax ? Math.min(cap, bandMax) : (cap || bandMax || "auto");
                    }
                  ]}
                  width={55}/>
                <Tooltip content={<CustomTooltip/>}/>

                {/* Shaded band area */}
                <Area type="monotone" dataKey="bull" stroke="#f5c842" strokeWidth={1}
                  strokeDasharray="5 4" fill="#f5c84206" dot={false} connectNulls activeDot={false}/>
                <Area type="monotone" dataKey="bear" stroke="#00e5a0" strokeWidth={1}
                  strokeDasharray="5 4" fill="#00e5a006" dot={false} connectNulls activeDot={false}/>
                <Area type="monotone" dataKey="base" stroke="#555555" strokeWidth={1.5}
                  strokeDasharray="8 4" fill="none" dot={false} connectNulls activeDot={false}/>

                {/* Actual price — most prominent */}
                <Line type="monotone" dataKey="price" stroke="#e0e0e0" strokeWidth={2.5}
                  dot={false} connectNulls activeDot={{ r: 3, fill: "#e0e0e0" }}/>

                {/* Analyst targets */}
                {data.targetHigh && <ReferenceLine y={data.targetHigh} stroke="#f5c84233"
                  strokeDasharray="3 5" label={{ value: `↑ $${data.targetHigh.toFixed(0)}`, fill: "#f5c84255", fontSize: 9, position: "right" }}/>}
                {data.targetMean && <ReferenceLine y={data.targetMean} stroke="#88888855"
                  strokeDasharray="3 5" label={{ value: `⬤ $${data.targetMean.toFixed(0)}`, fill: "#888", fontSize: 9, position: "right" }}/>}
                {data.targetLow  && <ReferenceLine y={data.targetLow}  stroke="#00e5a033"
                  strokeDasharray="3 5" label={{ value: `↓ $${data.targetLow.toFixed(0)}`,  fill: "#00e5a055", fontSize: 9, position: "right" }}/>}

                {/* Today line */}
                <ReferenceLine x={new Date().toISOString().slice(5,10)}
                  stroke="#2a2a2a" strokeWidth={1.5}
                  label={{ value: "today", fill: "#2a2a2a", fontSize: 9, position: "insideTopLeft" }}/>

                {/* Phase boundary */}
                {growthYears > 3 && (() => {
                  const phase2Date = new Date();
                  phase2Date.setFullYear(phase2Date.getFullYear() + 3);
                  return <ReferenceLine x={phase2Date.toISOString().slice(5,10)}
                    stroke="#1a1a1a" strokeDasharray="2 4"
                    label={{ value: "phase 2", fill: "#1a1a1a", fontSize: 8, position: "insideTopLeft" }}/>;
                })()}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ── Context box ── */}
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* Zone interpretation */}
            <div style={{ background: "#070707", border: `1px solid ${valZone?.color || "#141414"}22`, borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: valZone?.color || "#555", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                {valZone?.label}
              </div>
              <div style={{ fontSize: 11, color: "#444", lineHeight: 1.7 }}>{valZone?.desc}</div>
              {upsideToBase != null && (
                <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: upsideToBase > 0 ? "#00e5a0" : "#ff6b6b" }}>
                  {upsideToBase >= 0 ? "+" : ""}{upsideToBase.toFixed(0)}% to base in {growthYears}Y
                  {data.targetMean && <span style={{ fontSize: 10, color: "#444", fontWeight: 400, marginLeft: 8 }}>
                    vs analyst {((data.targetMean - data.currentPrice) / data.currentPrice * 100).toFixed(0)}%
                  </span>}
                </div>
              )}
            </div>

            {/* Growth & PE assumptions */}
            <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ fontSize: 10, color: "#333", fontWeight: 700, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Growth inputs</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {[
                  ["Phase 1", `${(effectiveG1*100).toFixed(1)}%/yr`, data.g1Source, customG1 ? "#f5c842" : "#888"],
                  ["Phase 2", `${(effectiveG2*100).toFixed(1)}%/yr`, data.g2Source, customG2 ? "#f5c842" : "#555"],
                  ["Base EPS", data.baseEps ? `$${data.baseEps.toFixed(2)}` : "—", data.baseEpsSource || "trailing", "#888"],
                  ["PE basis", `${data.peBear.toFixed(0)}–${data.peBase.toFixed(0)}–${data.peBull.toFixed(0)}×`, data.useForwardPEBasis ? "fwd PE" : `${data.histPEsCount} pts`, "#555"],
                ].map(([label, val, source, color]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 10, color: "#333" }}>{label}</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color }}>{val}</span>
                    <span style={{ fontSize: 9, color: "#2a2a2a" }}>{source}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
function MarktTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/market");
      const d = await r.json();
      setData(d);
      setLastUpdated(new Date());
      // Save snapshot to DB
      if (d.vix) {
        await SB.from("market_snapshots").upsert({
          date: new Date().toISOString().split("T")[0],
          vix: d.vix,
          fear_greed: d.fearGreed?.score,
          sp500_price: d.sp500,
          sp500_change: d.sp500Change,
          treasury_10y: d.treasury10y,
          dxy: d.dxy,
        }, { onConflict: "date" });
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const vixSignal = (vix) => {
    if (!vix) return ["—", "#444", "no data"];
    if (vix < 15) return ["COMPLACENT", "#f5c842", "Market is complacent — valuations often elevated"];
    if (vix < 20) return ["CALM", "#00e5a0", "Normal market conditions"];
    if (vix < 30) return ["ELEVATED", "#f5c842", "Elevated nervousness — watch risk"];
    if (vix < 40) return ["FEAR", "#ff6b6b", "Panic present — historically a buying zone"];
    return ["EXTREME FEAR", "#ff4444", "Extreme panic — selective buying opportunities"];
  };

  const fgSignal = (score) => {
    if (score === null || score === undefined) return ["—", "#444"];
    if (score <= 25) return ["EXTREME FEAR", "#00e5a0"];
    if (score <= 45) return ["FEAR", "#7be0c0"];
    if (score <= 55) return ["NEUTRAL", "#f5c842"];
    if (score <= 75) return ["GREED", "#ff9966"];
    return ["EXTREME GREED", "#ff6b6b"];
  };

  const yieldSignal = (y) => {
    if (!y) return ["—", "#444"];
    if (y < 3.5) return ["LOW", "#00e5a0"];
    if (y < 4.5) return ["NEUTRAL", "#f5c842"];
    return ["HIGH", "#ff6b6b"];
  };

  const overallSignal = () => {
    if (!data) return null;
    let score = 0;
    let factors = 0;
    if (data.vix) { score += data.vix > 30 ? 2 : data.vix > 20 ? 1 : 0; factors++; }
    if (data.fearGreed?.score != null) { score += data.fearGreed.score < 30 ? 2 : data.fearGreed.score < 45 ? 1 : 0; factors++; }
    if (data.treasury10y) { score += data.treasury10y < 3.5 ? 1 : data.treasury10y > 4.5 ? -1 : 0; factors++; }
    const avg = factors ? score / factors : 0;
    if (avg >= 1.5) return ["STRONG BUY ZONE", "#00e5a0", "Multiple indicators point to attractive entry timing"];
    if (avg >= 0.8) return ["MODERATE BUY ZONE", "#7be0c0", "Conditions favorable but not extreme"];
    if (avg >= 0) return ["NEUTRAL", "#f5c842", "Mixed signal — be selective"];
    return ["CAUTION", "#ff6b6b", "Market conditions favor patience"];
  };

  const overall = overallSignal();
  const [vLabel, vColor, vDesc] = vixSignal(data?.vix);
  const [fgLabel, fgColor] = fgSignal(data?.fearGreed?.score);
  const [yLabel, yColor] = yieldSignal(data?.treasury10y);

  return (
    <div>
      {/* Overall signal */}
      {overall && (
        <div style={{ background: overall[1] + "11", border: `1px solid ${overall[1]}33`, borderRadius: 14, padding: "20px 24px", marginBottom: 24, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 32 }}>
            {overall[0].includes("STRONG") ? "🟢" : overall[0].includes("MODERATE") ? "🟡" : overall[0].includes("NEUTRAL") ? "🟡" : "🔴"}
          </div>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: overall[1] }}>{overall[0]}</div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{overall[2]}</div>
          </div>
          <div style={{ marginLeft: "auto", fontSize: 10, color: "#2a2a2a", fontFamily: "monospace" }}>
            {lastUpdated ? `updated ${lastUpdated.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : ""}
          </div>
          <button onClick={load} disabled={loading} style={{ background: "transparent", border: "1px solid #222", borderRadius: 8, color: loading ? "#2a2a2a" : "#555", padding: "7px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {loading ? <Spinner/> : <Icon name="refresh" size={13}/>}
          </button>
        </div>
      )}

      {loading && !data ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#333", fontFamily: "monospace", padding: "40px 0" }}><Spinner/> Loading market data…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Rij 1: VIX + Fear & Greed */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* VIX */}
            <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "20px 22px" }}>
              <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12 }}>VIX — Volatility Index</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                <span style={{ fontFamily: "monospace", fontSize: 36, fontWeight: 700, color: vColor }}>{data?.vix?.toFixed(1) || "—"}</span>
                {data?.vixChange != null && (
                  <span style={{ fontFamily: "monospace", fontSize: 13, color: data.vixChange >= 0 ? "#ff6b6b" : "#00e5a0" }}>
                    {data.vixChange >= 0 ? "+" : ""}{data.vixChange.toFixed(1)}%
                  </span>
                )}
              </div>
              <div style={{ display: "inline-block", background: vColor + "22", border: `1px solid ${vColor}44`, borderRadius: 5, padding: "3px 10px", fontSize: 11, fontWeight: 700, color: vColor, fontFamily: "monospace", marginBottom: 8 }}>{vLabel}</div>
              <div style={{ fontSize: 11, color: "#444", lineHeight: 1.5 }}>{vDesc}</div>
              {/* VIX schaal */}
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  {["10", "15", "20", "30", "40+"].map(v => <span key={v} style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace" }}>{v}</span>)}
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "linear-gradient(to right, #00e5a0, #f5c842, #ff6b6b)", position: "relative" }}>
                  {data?.vix && (
                    <div style={{ position: "absolute", left: `${Math.min(95, Math.max(2, ((data.vix - 10) / 30) * 100))}%`, top: -4, width: 3, height: 14, background: "#fff", borderRadius: 2, transform: "translateX(-50%)" }}/>
                  )}
                </div>
              </div>
            </div>

            {/* Fear & Greed */}
            <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "20px 22px" }}>
              <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12 }}>Fear & Greed Index — CNN</div>
              {data?.fearGreed ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 36, fontWeight: 700, color: fgColor }}>{data.fearGreed.score}</span>
                    <span style={{ fontSize: 12, color: "#555" }}>/ 100</span>
                  </div>
                  <div style={{ display: "inline-block", background: fgColor + "22", border: `1px solid ${fgColor}44`, borderRadius: 5, padding: "3px 10px", fontSize: 11, fontWeight: 700, color: fgColor, fontFamily: "monospace", marginBottom: 8 }}>{fgLabel}</div>
                  <div style={{ fontSize: 11, color: "#444" }}>
                    {data.fearGreed.score <= 25 ? "Historically a buy signal — fear drives prices too low" :
                     data.fearGreed.score <= 45 ? "Caution advised — market is nervous" :
                     data.fearGreed.score <= 55 ? "Mixed sentiment — no clear signal" :
                     data.fearGreed.score <= 75 ? "Market is greedy — valuations may be stretched" :
                     "Extreme greed — historically a time for caution"}
                  </div>
                  <div style={{ marginTop: 14, height: 6, borderRadius: 3, background: "linear-gradient(to right, #00e5a0, #f5c842, #ff6b6b)", position: "relative" }}>
                    <div style={{ position: "absolute", left: `${Math.min(95, Math.max(2, data.fearGreed.score))}%`, top: -4, width: 3, height: 14, background: "#fff", borderRadius: 2, transform: "translateX(-50%)" }}/>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: 9, color: "#00e5a0", fontFamily: "monospace" }}>FEAR</span>
                    <span style={{ fontSize: 9, color: "#ff6b6b", fontFamily: "monospace" }}>GREED</span>
                  </div>
                </>
              ) : (
                <div style={{ color: "#333", fontSize: 12 }}>Fear & Greed niet beschikbaar</div>
              )}
            </div>
          </div>

          {/* Rij 2: S&P500, Treasury, DXY */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {[
              {
                label: "S&P 500",
                value: data?.sp500 ? `$${data.sp500.toFixed(0)}` : "—",
                change: data?.sp500Change,
                desc: data?.sp500Change >= 0 ? "Market in uptrend" : "Market under pressure",
                color: data?.sp500Change >= 0 ? "#00e5a0" : "#ff6b6b",
                note: "General market direction"
              },
              {
                label: "10jr Treasury Yield",
                value: data?.treasury10y ? `${data.treasury10y.toFixed(2)}%` : "—",
                change: data?.treasury10yChange,
                changeUnit: "bps",
                desc: data?.treasury10y > 4.5 ? "High — pressure on growth stocks" : data?.treasury10y > 3.5 ? "Neutral" : "Low — favorable for tech/growth",
                color: yColor,
                note: "High yield = competition for equities"
              },
              {
                label: "USD Index (DXY)",
                value: data?.dxy ? data.dxy.toFixed(1) : "—",
                change: data?.dxyChange,
                desc: data?.dxy > 104 ? "Strong dollar — headwind for multinationals" : data?.dxy > 100 ? "Neutral" : "Weak dollar — favorable for EM and multinationals",
                color: data?.dxy > 104 ? "#ff6b6b" : data?.dxy > 100 ? "#f5c842" : "#00e5a0",
                note: "Strong = headwind for international revenue"
              }
            ].map(item => (
              <div key={item.label} style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "18px 20px" }}>
                <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>{item.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 24, fontWeight: 700, color: item.color }}>{item.value}</span>
                  {item.change != null && (
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: item.change >= 0 ? "#00e5a0" : "#ff6b6b" }}>
                      {item.change >= 0 ? "+" : ""}{item.change.toFixed(item.changeUnit ? 0 : 2)}{item.changeUnit || "%"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>{item.desc}</div>
                <div style={{ fontSize: 10, color: "#2a2a2a", fontStyle: "italic" }}>{item.note}</div>
              </div>
            ))}
          </div>

          {/* Rational conclusions */}
          <div style={{ background: "#070707", border: "1px solid #1a1a1a", borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 14 }}>Rational market context for entry decisions</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                data?.vix > 30
                  ? { signal: "✅", text: `VIX at ${data?.vix?.toFixed(1)} — elevated fear. Historically favorable for quality stock entry.`, color: "#00e5a0" }
                  : data?.vix < 15
                  ? { signal: "⚠️", text: `VIX at ${data?.vix?.toFixed(1)} — market is complacent. Exercise caution with new positions.`, color: "#f5c842" }
                  : { signal: "➡️", text: `VIX at ${data?.vix?.toFixed(1)} — normal volatility. No particular signal.`, color: "#888" },

                data?.fearGreed?.score <= 35
                  ? { signal: "✅", text: `Fear & Greed at ${data?.fearGreed?.score} (fear). Contrarian signal — others sell, you analyze rationally.`, color: "#00e5a0" }
                  : data?.fearGreed?.score >= 75
                  ? { signal: "⚠️", text: `Fear & Greed at ${data?.fearGreed?.score} (greed). Wait for a pullback or be more selective.`, color: "#ff6b6b" }
                  : { signal: "➡️", text: `Fear & Greed at ${data?.fearGreed?.score} (${data?.fearGreed?.rating || "neutral"}). Mixed sentiment.`, color: "#888" },

                data?.treasury10y > 4.5
                  ? { signal: "⚠️", text: `10yr yield at ${data?.treasury10y?.toFixed(2)}% — high. Growth stocks (tech/semi) face extra pressure. Higher discount rate = lower fair values.`, color: "#f5c842" }
                  : { signal: "✅", text: `10yr yield at ${data?.treasury10y?.toFixed(2)}% — acceptable for growth stocks.`, color: "#00e5a0" },
              ].filter(Boolean).map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 16 }}>{item.signal}</span>
                  <span style={{ fontSize: 12, color: item.color, lineHeight: 1.6 }}>{item.text}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("markt");
  const [shortlist, setShortlist] = useState([]);
  const [positions, setPositions] = useState([]);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const init = async () => {
      const [sl, pf] = await Promise.all([db.getShortlist(), db.getPortfolio()]);
      setShortlist(sl);
      if (pf.length === 0) {
        for (const p of DEFAULT_POSITIONS) await db.upsertPortfolio(p);
        setPositions(DEFAULT_POSITIONS);
      } else {
        setPositions(pf);
      }
      setBooting(false);
    };
    init();
  }, []);

  const addToShortlist = async (stock) => {
    const entry = { symbol: stock.symbol, target: null, thesis: "", status: "Watching" };
    await db.upsertShortlist(entry);
    if (!shortlist.find(s => s.symbol === stock.symbol)) setShortlist(p => [...p, { ...entry, addedAt: Date.now() }]);
    setTab("shortlist");
  };

  const TABS = [
    { id: "markt",     label: "Market",    icon: "chart" },
    { id: "shortlist", label: `Shortlist${shortlist.length ? ` (${shortlist.length})` : ""}`, icon: "star" },
    { id: "portfolio", label: "Portfolio", icon: "briefcase" },
    { id: "valuation", label: "Valuation", icon: "chart" },
    { id: "peg",       label: "PEG Chart", icon: "chart" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#040404", color: "#d0d0d0", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, textarea, select { outline: none; }
        input:focus, textarea:focus { border-color: #00e5a033 !important; }
        ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: #1e1e1e; }
        .recharts-tooltip-wrapper { outline: none; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #0e0e0e", padding: "0 32px", display: "flex", alignItems: "center", gap: 32, background: "#060606", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ padding: "16px 0", display: "flex", alignItems: "baseline", gap: 7 }}>
          <span style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>ALPHA</span>
          <span style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, color: "#00e5a0" }}>DESK</span>
        </div>
        <div style={{ display: "flex", gap: 2, flex: 1 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ background: "transparent", border: "none", borderBottom: `2px solid ${tab === t.id ? "#00e5a0" : "transparent"}`, color: tab === t.id ? "#e0e0e0" : "#3a3a3a", padding: "16px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: tab === t.id ? 600 : 400, transition: "all 0.2s", whiteSpace: "nowrap" }}>
              <Icon name={t.icon} size={13}/> {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#1e1e1e", fontFamily: "monospace" }}>
          <Icon name="db" size={10}/> Supabase · Yahoo Finance
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {booting ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#2a2a2a", fontFamily: "monospace", padding: "60px 0" }}>
            <Spinner size={18}/> Connecting to database…
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 20 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: "#e0e0e0", letterSpacing: -0.3 }}>
                {tab === "markt" && "Market Dashboard"}
                {tab === "shortlist" && "Entry Timing Dashboard"}
                {tab === "portfolio" && "Portfolio"}
                {tab === "valuation" && "Valuation"}
                {tab === "peg" && "PEG History"}
              </h1>
              <p style={{ color: "#2a2a2a", fontSize: 12, marginTop: 3 }}>
                {tab === "markt" && "Rational macro context · VIX · Fear & Greed · Yields · Sentiment"}
                {tab === "shortlist" && "52-week position · analyst targets · entry signal per stock"}
                {tab === "portfolio" && "Live P&L · positions synced with Supabase"}
                {tab === "valuation" && "Fair value bands · price vs projected EPS × PE multiple"}
                {tab === "peg" && "PEG trend · grows with every scan"}
              </p>
            </div>
            <div style={{ display: tab === "markt" ? "block" : "none" }}>
              <MarktTab/>
            </div>
            <div style={{ display: tab === "shortlist" ? "block" : "none" }}>
              <ShortlistTab shortlist={shortlist} setShortlist={setShortlist}/>
            </div>
            <div style={{ display: tab === "portfolio" ? "block" : "none" }}>
              <PortfolioTab positions={positions} setPositions={setPositions}/>
            </div>
            <div style={{ display: tab === "valuation" ? "block" : "none" }}>
              <ValuationTab positions={positions} shortlist={shortlist}/>
            </div>
            <div style={{ display: tab === "peg" ? "block" : "none" }}>
              <PEGChartTab portfolioSymbols={positions.map(p => p.symbol)}/>
            </div>
          </>
        )}
      </div>
    </div>
  );
}