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
    // Priority: Edge Intel growth signals (most recent) > manual growth_forecasts
    // Edge Intel signals are what the user enters from their ASML PDF reports
    const today = new Date().toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];

    const [{ data: edgeData }, { data: manualData }] = await Promise.all([
      // Edge Intel: most recent signal for this symbol (within last 30 days)
      SB.from("edge_intel_growth_signals")
        .select("*")
        .eq("symbol", symbol)
        .gte("as_of_date", thirtyDaysAgo)
        .order("as_of_date", { ascending: false })
        .limit(1),
      // Manual forecasts (growth_forecasts table, older system)
      SB.from("growth_forecasts")
        .select("*")
        .or(`symbol.eq.${symbol},symbol.is.null`)
        .or("valid_until.is.null,valid_until.gte." + today)
        .order("symbol", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);

    // Edge Intel signal takes priority — map to same shape as growth_forecasts
    if (edgeData?.length) {
      const sig = edgeData[0];
      return {
        g1_pct: sig.implied_g1_pct,
        g2_pct: sig.implied_g2_pct,
        source: "⚡ Edge Intel",
        note: sig.key_driver,
        signal: sig.signal,
        vs_consensus: sig.vs_consensus,
        from_edge_intel: true,
      };
    }

    // Fallback: manual growth_forecasts
    if (!manualData?.length) return null;
    return manualData.find(r => r.symbol === symbol)
      || manualData.find(r => r.sector === "semiconductor")
      || manualData[0];
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

function PortfolioTab({ positions, setPositions, fearGreed }) {
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

  // Semicon exposure — for Fear & Greed context
  const SEMICON_SYMS = new Set(["MU","TSM","MRVL","CLS","LRCX","KLAC","ASML","AVGO","NVDA","AMD","AMAT"]);
  const semiValue = positions.reduce((s, p) => {
    if (!SEMICON_SYMS.has(p.symbol)) return s;
    return s + p.shares * (quotes[p.symbol]?.price || p.avgCost);
  }, 0);
  const semiPct = totalValue > 0 ? (semiValue / totalValue) * 100 : 0;

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
      {/* ── Fear & Greed × Semicon Banner ── */}
      {fearGreed != null && (() => {
        const fg = fearGreed;
        const isExtremeFear  = fg <= 25;
        const isFear         = fg <= 45;
        const isExtremeGreed = fg >= 75;
        const isGreed        = fg >= 55;
        const semiPctRound   = Math.round(semiPct);

        if (isExtremeFear) return (
          <div style={{ background:"#00e5a008", border:"1.5px solid #00e5a033", borderRadius:12, padding:"14px 16px", marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:"#00e5a0", marginBottom:4 }}>
                  ⚡ EXTREME FEAR — Historisch koopmoment voor jouw semicons
                </div>
                <div style={{ fontSize:11, color:"#444", lineHeight:1.7 }}>
                  Fear & Greed staat op <span style={{ color:"#00e5a0", fontFamily:"monospace", fontWeight:700 }}>{fg}</span>. 
                  Jouw semicon exposure is <span style={{ fontFamily:"monospace", fontWeight:700, color:"#e0e0e0" }}>{semiPctRound}%</span> van de portfolio.
                  Bij extreme fear worden semicons disproportioneel hard afgestraft — fundamentals veranderen niet.
                  Als jouw Edge Intel data nog bullish is, dan is dit het toevoegingsmoment.
                </div>
              </div>
              <div style={{ fontFamily:"monospace", fontSize:28, fontWeight:700, color:"#00e5a0", flexShrink:0, marginLeft:16 }}>{fg}</div>
            </div>
          </div>
        );
        if (isFear) return (
          <div style={{ background:"#7be0c008", border:"1px solid #7be0c022", borderRadius:12, padding:"12px 16px", marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#7be0c0", marginBottom:3 }}>📉 FEAR — Markt is nerveus, semicons onder druk</div>
            <div style={{ fontSize:11, color:"#444", lineHeight:1.6 }}>
              Fear & Greed <span style={{ fontFamily:"monospace", fontWeight:700, color:"#7be0c0" }}>{fg}</span> · {semiPctRound}% semicon exposure. 
              Kijk naar je Edge Intel signals — als fundamentals intact zijn, is dit accumulation territory.
            </div>
          </div>
        );
        if (isExtremeGreed) return (
          <div style={{ background:"#ff6b6b08", border:"1px solid #ff6b6b22", borderRadius:12, padding:"12px 16px", marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#ff6b6b", marginBottom:3 }}>⚠️ EXTREME GREED — Overweeg risico te verminderen</div>
            <div style={{ fontSize:11, color:"#444", lineHeight:1.6 }}>
              Fear & Greed <span style={{ fontFamily:"monospace", fontWeight:700, color:"#ff6b6b" }}>{fg}</span> · {semiPctRound}% semicon exposure. 
              Momentum kan nog doorzetten maar bij extreme greed zijn semicons historisch overpriced. 
              Zeker met {semiPctRound}% concentratie: trim posities die EXPENSIVE tonen in Valuation tab.
            </div>
          </div>
        );
        if (isGreed) return (
          <div style={{ background:"#f5c84208", border:"1px solid #f5c84222", borderRadius:12, padding:"12px 16px", marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#f5c842", marginBottom:3 }}>📈 GREED — Markt is optimistisch</div>
            <div style={{ fontSize:11, color:"#444", lineHeight:1.6 }}>
              Fear & Greed <span style={{ fontFamily:"monospace", fontWeight:700, color:"#f5c842" }}>{fg}</span> · {semiPctRound}% semicon. 
              Momentum traders actief — check Valuation tab voor posities die richting EXPENSIVE gaan.
            </div>
          </div>
        );
        return null; // Neutral — geen banner
      })()}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
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
                <div key={i} style={{ background: "#0a0a0a", borderRadius: 8, padding: "12px 14px", border: `1px solid ${a.conviction === "high" ? "#00e5a033" : "#1a1a1a"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 15, color: "#fff" }}>{a.symbol}</span>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#00e5a0", fontSize: 14 }}>${a.amount?.toLocaleString()}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: a.conviction === "high" ? "#00e5a0" : "#f5c842", textTransform: "uppercase", marginLeft: 8 }}>{a.conviction}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#444" }}>{a.shares} sh @ {price ? `$${price.toFixed(2)}` : "—"}</span>
                    <span style={{ fontSize: 11, color: "#444" }}>→ {newWeight.toFixed(1)}% weight</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#555", lineHeight: 1.5 }}>{a.rationale}</div>
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
            {[["Symbol", "symbol", "100px"], ["Shares", "shares", "100px"], ["Avg $", "avgCost", "120px"], ["Thesis", "thesis", "1 1 100%"]].map(([label, key, flex]) => (
              <div key={key} style={{ flex: flex.includes("%") ? flex : `0 0 ${flex}` }}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                <input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                  style={{ width: "100%", background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, color: "#d0d0d0", padding: "10px 11px", fontSize: 16, fontFamily: "monospace" }}/>
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
            <div key={p.symbol} style={{ borderBottom: "1px solid #0c0c0c", padding: "12px 16px" }}>
              {/* Row 1: Symbol + price + P&L */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 15, color: "#e0e0e0" }}>{p.symbol}</span>
                    {p.assetType === "etf" && <span style={{ fontSize: 9, color: "#555", border: "1px solid #222", borderRadius: 3, padding: "1px 5px" }}>ETF</span>}
                    {curr === "EUR" && <span style={{ fontSize: 9, color: "#444", fontFamily: "monospace" }}>€</span>}
                  </div>
                  {p.thesis && <div style={{ fontSize: 11, color: "#2a2a2a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "90%" }}>{p.thesis}</div>}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 700, color: "#d0d0d0" }}>
                    {price ? `${sym}${price.toFixed(2)}` : <Spinner/>}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: pl >= 0 ? "#00e5a0" : "#ff6b6b" }}>
                    {pl ? `${pl >= 0 ? "+" : ""}${sym}${Math.abs(pl).toFixed(0)}` : "—"}
                    {rt ? <span style={{ fontSize: 11, marginLeft: 4 }}>({fmt.pct(rt)})</span> : null}
                  </div>
                </div>
              </div>
              {/* Row 2: Stats chips */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: week52Pct !== null ? 8 : 0 }}>
                {[
                  [`${p.shares} sh`, "#555"],
                  [`avg ${sym}${p.avgCost.toFixed(0)}`, "#444"],
                  [value ? `val ${sym}${value.toFixed(0)}` : "—", "#555"],
                  [weight ? `${weight.toFixed(1)}%` : "—", "#444"],
                ].map(([label, color]) => (
                  <span key={label} style={{ fontSize: 11, color, fontFamily: "monospace", background: "#0d0d0d", borderRadius: 4, padding: "2px 7px" }}>{label}</span>
                ))}
                <button onClick={() => remove(p.symbol)} style={{ marginLeft: "auto", background: "transparent", border: "1px solid #1a1a1a", borderRadius: 5, color: "#333", padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>✕</button>
              </div>
              {/* 52W bar */}
              {week52Pct !== null && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace", whiteSpace: "nowrap" }}>52W LOW</span>
                  <div style={{ flex: 1, height: 4, background: "#111", borderRadius: 2, position: "relative" }}>
                    <div style={{ width: `${week52Pct}%`, height: "100%", background: week52Pct < 30 ? "#00e5a0" : week52Pct < 70 ? "#f5c842" : "#ff6b6b", borderRadius: 2 }}/>
                    <div style={{ position: "absolute", left: `${week52Pct}%`, top: -2, width: 2, height: 8, background: "#fff", transform: "translateX(-50%)", borderRadius: 1 }}/>
                  </div>
                  <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace", whiteSpace: "nowrap" }}>HIGH</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: week52Pct < 30 ? "#00e5a0" : week52Pct < 70 ? "#f5c842" : "#ff6b6b", fontFamily: "monospace" }}>
                    {week52Pct.toFixed(0)}%{recentSplit ? " ⚠split" : ""}
                  </span>
                </div>
              )}
            </div>
          );
        };

        const colHeader = null;

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

      // ── EPS + PE: config-driven consistent pair ─────────────────────────────
      // eps_basis='forward': forwardEps × absolute PE targets from config
      // eps_basis='trailing': trailingEps × absolute PE targets from config
      //
      // pe_base_abs is the NORMALIZED fair-value PE for this stock type —
      // NOT the current market PE. This means band t=0 shows if stock is
      // cheap (below base band) or expensive (above base band) vs history.
      //
      // MU example: trailing EPS $21.19, peBase=12 → $254 at t=0
      //   stock at $407 → ABOVE base → expensive vs normalized PE ✓
      //   (correct: MU trades at 19x trailing = above normalized 12x mid-cycle)
      //
      // META example: forward EPS $35.97, peBase=22 → $791 at t=0
      //   stock at $612 → BELOW base → BUY ZONE ✓
      //   (correct: META trades at fwd PE 17x vs historical fair 22x)

      const epsBasis = cfg.eps_basis || 'forward';
      let baseEps, anchorPE, useForwardPEBasis = true, histPEsCount = 0;

      if (epsBasis === 'trailing') {
        // Use trailing EPS — good for cyclicals at peak (MU), banks (BAC)
        // where forward EPS is distorted by cycle position
        baseEps  = (trailingEps && trailingEps > 0) ? trailingEps
                 : (currentPrice && trailingPE ? currentPrice / trailingPE : null);
        anchorPE = trailingPE || forwardPE || 15;
        useForwardPEBasis = false;
      } else {
        // Forward basis — most stocks: platform, growth, equipment
        //
        // SANITY CHECK: if forwardEps is >4× trailing EPS, Yahoo is likely
        // reporting a multi-year forward (e.g. MU FY2027 $98 vs trailing $21).
        // In that case, fall back to trailing EPS — the last known real earnings.
        // The PE bands from config already encode the normalized valuation range.
        const fwdEpsDistorted = forwardEps && trailingEps && trailingEps > 0
          && forwardEps > trailingEps * 4;

        if (fwdEpsDistorted) {
          // Trailing is the last real data point; config PE range handles the rest
          baseEps = (trailingEps && trailingEps > 0) ? trailingEps
                  : (currentPrice && trailingPE ? currentPrice / trailingPE : null);
        } else {
          baseEps = forwardEps
                  || (currentPrice && forwardPE ? currentPrice / forwardPE : null)
                  || (trailingEps && trailingEps > 0 ? trailingEps : null);
        }
        anchorPE = trailingPE || forwardPE || 20;
      }

      // Custom base EPS override — used for cyclicals like MU where trailing
      // EPS is stale (FY2025 $21 while running at $76+/yr in FY2026)
      // Set custom_base_eps in valuation_config to use through-cycle normalized EPS
      if (cfg.custom_base_eps && cfg.custom_base_eps > 0) {
        baseEps = cfg.custom_base_eps;
      }

      // PE bands from config — absolute values, not multipliers of current PE
      // This is the key: pe_base_abs encodes what "fair" historically means for this stock
      const peBear = cfg.pe_bear_abs || anchorPE * 0.65;
      const peBase = cfg.pe_base_abs || anchorPE;
      const peBull = cfg.pe_bull_abs || anchorPE * 1.40;

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

      // Apply custom_base_eps override before storing
      const effectiveBaseEps = (cfg.custom_base_eps && cfg.custom_base_eps > 0)
        ? cfg.custom_base_eps : baseEps;

      setData({
        symbol, currentPrice,
        trailingEps, forwardEps, baseEps: effectiveBaseEps,
        stockType: cfg.stock_type || "generic",
        cfgNote: cfg.note || null,
        cfgBaseEps: cfg.custom_base_eps || null,
        epsBasis: epsBasis,
        anchorPE: anchorPE,
        baseEpsSource: (cfg.custom_base_eps && cfg.custom_base_eps > 0)
          ? `custom $${cfg.custom_base_eps}/yr (through-cycle)`
          : (epsBasis === 'trailing' ? "trailing EPS" : (forwardEps ? "forward EPS" : "derived")),
        g1Auto, g2Auto, g1Source, g2Source, g1Capped, rawG1,
        peBear, peBase, peBull,
        anchorPE,
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
              style={{ background: selected === sym ? "#00e5a022" : "#0a0a0a", border: `1px solid ${selected === sym ? "#00e5a066" : "#1e1e1e"}`, borderRadius: 7, color: selected === sym ? "#00e5a0" : "#555", padding: "7px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 13, fontWeight: selected === sym ? 700 : 400 }}>
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
              {data.cfgNote && (
              <div style={{ fontSize: 10, color: "#444", marginTop: 4, lineHeight: 1.6, maxWidth: 600 }}>
                {data.cfgNote}
              </div>
            )}
            </div>
            {forecast && (
              <div style={{ fontSize: 10, background: forecast.from_edge_intel ? "#f5c84211" : "#00e5a011", border: `1px solid ${forecast.from_edge_intel ? "#f5c84233" : "#00e5a033"}`, borderRadius: 5, padding: "4px 10px", color: forecast.from_edge_intel ? "#f5c842" : "#00e5a0" }}>
                {forecast.from_edge_intel ? "⚡" : "✓"} {forecast.source}
                {forecast.note && <span style={{ color: "#555", marginLeft: 6 }}>— {forecast.note}</span>}
                {forecast.signal && <span style={{ marginLeft: 8, textTransform: "uppercase", fontWeight: 700, color: forecast.signal === "bullish" ? "#00e5a0" : forecast.signal === "bearish" ? "#ff6b6b" : "#888" }}>{forecast.signal}</span>}
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
          <div style={{ marginTop: 10, fontSize: 10, color: "#333", lineHeight: 1.7 }}>
            <span style={{ color: "#2a2a2a" }}>Phase 1 = yr 1–{Math.min(growthYears, 3)} · Phase 2 = yr {Math.min(growthYears, 3)+1}–{growthYears} · PE {data.peBear.toFixed(0)}/{data.peBase.toFixed(0)}/{data.peBull.toFixed(0)}× (bear/base/bull)</span>
            {forecast?.from_edge_intel && (
              <div style={{ marginTop: 6, padding: "6px 10px", background: "#f5c84211", border: "1px solid #f5c84222", borderRadius: 6, color: "#f5c842" }}>
                ⚡ Growth driven by Edge Intel signal from {forecast.as_of_date || "recent"}.
                To update: go to Edge Intel → Growth Signals → add new signal for {data.symbol}.
              </div>
            )}
            {!forecast && (
              <div style={{ marginTop: 6, color: "#2a2a2a" }}>
                No Edge Intel signal active. Add one in ⚡ Edge Intel → Growth Signals to override with your ASML data.
              </div>
            )}
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
                  ["Base EPS", data.baseEps ? `$${data.baseEps.toFixed(2)}` : "—", data.cfgBaseEps ? "custom override" : (data.baseEpsSource || "trailing"), data.cfgBaseEps ? "#f5c842" : "#888"],
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

          {/* ── Investment thesis from config ── */}
          {data.cfgNote && (
            <div style={{ marginTop: 10, background: "#070707", border: "1px solid #1e1e1e", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, color: "#2a2a2a", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                {data.symbol} · Investment Thesis & Edge Intel Link
              </div>
              <div style={{ fontSize: 11, color: "#3a3a3a", lineHeight: 1.8 }}>
                {data.cfgNote}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
// ── Edge Intel shared components (top-level — never re-defined on render) ────
// ── Edge Intel Components (top-level, never re-created on render) ─────────────

function EiNavBtn({ id, label, activeSection, onSelect }) {
  const active = activeSection === id;
  return (
    <button onClick={() => onSelect(id)} style={{
      flexShrink: 0,
      padding: "10px 18px",
      borderRadius: 10,
      border: `1.5px solid ${active ? "#00e5a066" : "#222"}`,
      background: active ? "#00e5a012" : "#0c0c0c",
      color: active ? "#00e5a0" : "#555",
      fontWeight: active ? 700 : 500,
      fontSize: 13,
      cursor: "pointer",
      whiteSpace: "nowrap",
      minHeight: 44,
      touchAction: "manipulation",
      WebkitTapHighlightColor: "transparent",
      transition: "all 0.15s",
    }}>{label}</button>
  );
}

// Stacked label + input, full-width by default on mobile
function EiField({ label, value, onChange, type="text", options=null, placeholder="", hint="" }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6, flex:"1 1 160px", minWidth:0 }}>
      <span style={{ fontSize:11, fontWeight:600, color:"#666", textTransform:"uppercase", letterSpacing:"0.7px" }}>{label}</span>
      {options
        ? <select value={value} onChange={e => onChange(e.target.value)} style={{
            width:"100%", background:"#111", border:"1.5px solid #252525", borderRadius:10,
            color:"#e0e0e0", padding:"12px 14px", fontSize:16, minHeight:48,
            WebkitAppearance:"none", appearance:"none",
            backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M0 0l6 8 6-8z' fill='%23555'/%3E%3C/svg%3E")`,
            backgroundRepeat:"no-repeat", backgroundPosition:"right 14px center", paddingRight:36,
          }}>
            {options.map(o => <option key={o} value={o}>{o.replace(/_/g," ")}</option>)}
          </select>
        : <input
            type={type === "number" ? "text" : type}
            inputMode={type === "number" ? "decimal" : "text"}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            style={{
              width:"100%", background:"#111", border:"1.5px solid #252525", borderRadius:10,
              color:"#e0e0e0", padding:"12px 14px", fontSize:16, minHeight:48,
              fontFamily:"monospace",
            }}
          />
      }
      {hint && <span style={{ fontSize:10, color:"#2a2a2a" }}>{hint}</span>}
    </div>
  );
}

function EiCard({ label, value, color="#888", sub="" }) {
  return (
    <div style={{ background:"#111", borderRadius:10, padding:"12px 14px", border:"1px solid #1a1a1a" }}>
      <div style={{ fontSize:9, color:"#333", textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>{label}</div>
      <div style={{ fontFamily:"monospace", fontSize:16, fontWeight:700, color }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:"#2a2a2a", marginTop:3 }}>{sub}</div>}
    </div>
  );
}

function EiSaveBtn({ onClick, saving }) {
  return (
    <button onClick={onClick} disabled={saving} style={{
      flex:"1 1 100%",
      background: saving ? "#1a1a1a" : "#00e5a0",
      border:"none", borderRadius:12, color: saving ? "#555" : "#000",
      padding:"15px 24px", fontSize:16, fontWeight:700, cursor:"pointer",
      minHeight:52, touchAction:"manipulation", WebkitTapHighlightColor:"transparent",
      transition:"all 0.15s",
    }}>{saving ? "Saving…" : "Save"}</button>
  );
}

// Unified delete+edit row for a data record card
function EiRecordActions({ onEdit, onDelete }) {
  return (
    <div style={{ display:"flex", gap:8, marginTop:10, borderTop:"1px solid #1a1a1a", paddingTop:10 }}>
      {onEdit && (
        <button onClick={onEdit} style={{
          flex:1, background:"#1a1a1a", border:"1.5px solid #252525", borderRadius:8,
          color:"#888", fontSize:13, padding:"9px 0", cursor:"pointer", fontWeight:600,
          touchAction:"manipulation",
        }}>✎ Edit</button>
      )}
      <button onClick={onDelete} style={{
        flex:1, background:"#1a1a1a", border:"1.5px solid #ff6b6b22", borderRadius:8,
        color:"#ff6b6b", fontSize:13, padding:"9px 0", cursor:"pointer", fontWeight:600,
        touchAction:"manipulation",
      }}>✕ Delete</button>
    </div>
  );
}

// ── Edge Intel Tab ────────────────────────────────────────────────────────────
function EdgeIntelTab() {
  const [section, setSection]  = useState("signals");
  const [marketData, setMkt]   = useState([]);
  const [capexData, setCap]    = useState([]);
  const [toolData, setTools]   = useState([]);
  const [signals, setSigs]     = useState([]);
  const [loading, setLoading]  = useState(true);
  const [saving, setSaving]    = useState(false);

  const [mktF, setMktF]   = useState({ period:"", segment:"DRAM", metric:"revenue_growth_yoy", value:"", notes:"" });
  const [capF, setCapF]   = useState({ period:"", company:"TSMC", capex_usd_b:"", capex_growth_yoy:"", primary_use:"EUV_ramp", notes:"" });
  const [toolF, setToolF] = useState({ period:"", tool_type:"NXE_low_NA", units_plan:"", asp_eur_m:"230", notes:"" });
  const [sigF, setSigF]   = useState({ symbol:"ASML", implied_g1_pct:"", implied_g2_pct:"", signal:"bullish", vs_consensus:"above", delta_pct:"", key_driver:"" });

  const ASP = { DUV:45, NXE_low_NA:230, NXE_high_NA:380, EXE:380 };

  const load = async () => {
    setLoading(true);
    const [{ data:m },{ data:c },{ data:t },{ data:s }] = await Promise.all([
      SB.from("edge_intel_market").select("*").neq("period","REFERENCE").order("period",{ascending:false}).limit(80),
      SB.from("edge_intel_capex").select("*").order("period",{ascending:false}).limit(60),
      SB.from("edge_intel_asml_tools").select("*").neq("period","REFERENCE").order("period",{ascending:false}).limit(60),
      SB.from("edge_intel_growth_signals").select("*").order("as_of_date",{ascending:false}).limit(30),
    ]);
    setMkt(m||[]); setCap(c||[]); setTools(t||[]); setSigs(s||[]);
    setLoading(false);
  };
  useEffect(()=>{ load(); },[]);
  useEffect(()=>{ setToolF(f=>({...f, asp_eur_m: String(ASP[f.tool_type]||"")})); },[toolF.tool_type]);

  const saveMkt = async () => {
    if (!mktF.period||!mktF.value) return;
    setSaving(true);
    await SB.from("edge_intel_market").upsert({
      period:mktF.period, segment:mktF.segment, metric:mktF.metric,
      value:parseFloat(mktF.value), notes:mktF.notes||null
    },{ onConflict:"period,segment,metric" });
    setMktF(f=>({...f,value:"",notes:""}));
    await load(); setSaving(false);
  };

  const saveCap = async () => {
    if (!capF.period||!capF.company) return;
    setSaving(true);
    await SB.from("edge_intel_capex").upsert({
      period:capF.period, company:capF.company,
      capex_usd_b:capF.capex_usd_b?parseFloat(capF.capex_usd_b):null,
      capex_growth_yoy:capF.capex_growth_yoy?parseFloat(capF.capex_growth_yoy):null,
      primary_use:capF.primary_use, notes:capF.notes||null
    },{ onConflict:"period,company" });
    setCapF(f=>({...f,capex_usd_b:"",capex_growth_yoy:"",notes:""}));
    await load(); setSaving(false);
  };

  const saveTool = async () => {
    if (!toolF.period||!toolF.units_plan) return;
    setSaving(true);
    await SB.from("edge_intel_asml_tools").upsert({
      period:toolF.period, tool_type:toolF.tool_type,
      units_plan:parseFloat(toolF.units_plan),
      asp_eur_m:toolF.asp_eur_m?parseFloat(toolF.asp_eur_m):ASP[toolF.tool_type],
      notes:toolF.notes||null
    },{ onConflict:"period,tool_type" });
    setToolF(f=>({...f,units_plan:"",notes:""}));
    await load(); setSaving(false);
  };

  const saveSig = async () => {
    if (!sigF.symbol||!sigF.implied_g1_pct) return;
    setSaving(true);
    await SB.from("edge_intel_growth_signals").upsert({
      as_of_date:new Date().toISOString().split("T")[0],
      symbol:sigF.symbol, implied_g1_pct:parseFloat(sigF.implied_g1_pct),
      implied_g2_pct:sigF.implied_g2_pct?parseFloat(sigF.implied_g2_pct):null,
      signal:sigF.signal, vs_consensus:sigF.vs_consensus,
      delta_pct:sigF.delta_pct?parseFloat(sigF.delta_pct):null,
      key_driver:sigF.key_driver||null
    },{ onConflict:"as_of_date,symbol" });
    await load(); setSaving(false);
  };

  const byPeriod = arr => arr.reduce((acc,r)=>{ (acc[r.period]=acc[r.period]||[]).push(r); return acc; },{});

  // ASML revenue calc
  const asmlQ = {};
  toolData.forEach(t=>{
    if (!asmlQ[t.period]) asmlQ[t.period]={ period:t.period, total:0, items:[] };
    const rev=(t.units_plan||0)*(t.asp_eur_m||0);
    asmlQ[t.period].total+=rev;
    asmlQ[t.period].items.push({type:t.tool_type,units:t.units_plan,asp:t.asp_eur_m,rev});
  });

  if (loading) return <div style={{ display:"flex", justifyContent:"center", padding:60 }}><Spinner size={24}/></div>;

  const sColor = { bullish:"#00e5a0", neutral:"#f5c842", bearish:"#ff6b6b" };
  const vColor = { above:"#00e5a0", in_line:"#f5c842", below:"#ff6b6b" };
  const impliedRev = (parseFloat(toolF.units_plan)||0)*(parseFloat(toolF.asp_eur_m)||0);

  return (
    <div>
      {/* ── Nav ── */}
      <div className="ei-nav">
        {[["signals","⚡ Signals"],["market","📊 Market"],["capex","💰 Capex"],["tools","🔧 Tool Plan"],["calc","📐 ASML Calc"]].map(([id,label])=>(
          <button key={id} className={"ei-nav-btn"+(section===id?" active":"")} onClick={()=>setSection(id)}>{label}</button>
        ))}
      </div>

      {/* ════ GROWTH SIGNALS ════ */}
      {section==="signals" && <div className="ei-section">
        <div className="ei-form accent-green">
          <div className="ei-form-title green">⚡ New Growth Signal</div>

          <div className="ei-row">
            <div className="ei-field">
              <span className="ei-label">Stock</span>
              <select value={sigF.symbol} onChange={e=>setSigF(f=>({...f,symbol:e.target.value}))}>
                {["ASML","TSM","MU","MRVL","AVGO","LRCX","KLAC","CLS","POWL","LLY","META","BAC"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="ei-field">
              <span className="ei-label">Phase 1 Growth %</span>
              <input type="text" inputMode="decimal" value={sigF.implied_g1_pct}
                onChange={e=>setSigF(f=>({...f,implied_g1_pct:e.target.value}))}
                placeholder="e.g. 28" autoComplete="off" autoCorrect="off"/>
            </div>
            <div className="ei-field">
              <span className="ei-label">Phase 2 Growth %</span>
              <input type="text" inputMode="decimal" value={sigF.implied_g2_pct}
                onChange={e=>setSigF(f=>({...f,implied_g2_pct:e.target.value}))}
                placeholder="e.g. 12" autoComplete="off" autoCorrect="off"/>
            </div>
          </div>

          <div className="ei-row">
            <div className="ei-field">
              <span className="ei-label">Signal</span>
              <select value={sigF.signal} onChange={e=>setSigF(f=>({...f,signal:e.target.value}))}>
                {["bullish","neutral","bearish"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="ei-field">
              <span className="ei-label">vs Consensus</span>
              <select value={sigF.vs_consensus} onChange={e=>setSigF(f=>({...f,vs_consensus:e.target.value}))}>
                {["above","in_line","below"].map(s=><option key={s} value={s}>{s.replace("_"," ")}</option>)}
              </select>
            </div>
            <div className="ei-field">
              <span className="ei-label">Delta %</span>
              <input type="text" inputMode="decimal" value={sigF.delta_pct}
                onChange={e=>setSigF(f=>({...f,delta_pct:e.target.value}))}
                placeholder="+12" autoComplete="off" autoCorrect="off"/>
            </div>
          </div>

          <div className="ei-row" style={{ marginBottom:12 }}>
            <div className="ei-field" style={{ gridColumn:"1/-1" }}>
              <span className="ei-label">Key Driver</span>
              <input type="text" value={sigF.key_driver}
                onChange={e=>setSigF(f=>({...f,key_driver:e.target.value}))}
                placeholder="e.g. NXE Q3 +4 units above consensus"
                autoComplete="off" autoCorrect="off" autoCapitalize="off"/>
            </div>
          </div>

          <button className="ei-save" disabled={saving} onClick={saveSig}>{saving?"Saving…":"Save Signal"}</button>
          <div style={{ marginTop:10, fontSize:11, color:"#2a2a2a", lineHeight:1.6 }}>
            Signals auto-feed into Valuation tab — override auto-detected growth rates.
          </div>
        </div>

        {signals.length===0
          ? <div className="ei-empty">No signals yet — enter your first above</div>
          : signals.map(s=>(
            <div key={s.id} className="ei-signal" style={{ borderColor:`${sColor[s.signal]}33` }}>
              <div className="ei-signal-hdr">
                <div>
                  <span style={{ fontFamily:"monospace", fontWeight:700, fontSize:20, color:"#e0e0e0" }}>{s.symbol}</span>
                  <span className="ei-signal-badge" style={{ color:sColor[s.signal], background:sColor[s.signal]+"18" }}>{s.signal}</span>
                </div>
                <span style={{ fontSize:11, color:"#333" }}>{s.as_of_date}</span>
              </div>
              <div className="ei-signal-stats">
                <div>
                  <div style={{ fontSize:10, color:"#444", marginBottom:3 }}>Phase 1</div>
                  <div style={{ fontFamily:"monospace", fontSize:18, fontWeight:700, color:"#f5c842" }}>{s.implied_g1_pct}%</div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:"#444", marginBottom:3 }}>Phase 2</div>
                  <div style={{ fontFamily:"monospace", fontSize:18, fontWeight:700, color:"#555" }}>{s.implied_g2_pct??'—'}%</div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:"#444", marginBottom:3 }}>vs Consensus</div>
                  <div style={{ fontSize:14, fontWeight:700, color:vColor[s.vs_consensus] }}>
                    {s.vs_consensus==="above"?"▲ above":s.vs_consensus==="below"?"▼ below":"= in line"}
                    {s.delta_pct!=null && <span style={{ marginLeft:6, fontSize:12 }}>({s.delta_pct>0?"+":""}{s.delta_pct}%)</span>}
                  </div>
                </div>
              </div>
              {s.key_driver && <div style={{ fontSize:12, color:"#555", fontStyle:"italic", marginBottom:4, lineHeight:1.5 }}>{s.key_driver}</div>}
              <div className="ei-actions">
                <button className="ei-btn-del" onClick={async()=>{ await SB.from("edge_intel_growth_signals").delete().eq("id",s.id); load(); }}>✕ Delete</button>
              </div>
            </div>
          ))
        }
      </div>}

      {/* ════ MARKET DATA ════ */}
      {section==="market" && <div className="ei-section">
        <div className="ei-form">
          <div className="ei-form-title">📊 Add Market Data</div>
          <div className="ei-row">
            <div className="ei-field">
              <span className="ei-label">Period</span>
              <input type="text" value={mktF.period} onChange={e=>setMktF(f=>({...f,period:e.target.value}))}
                placeholder="Apr-2026" autoComplete="off" autoCorrect="off"/>
              <span className="ei-hint">e.g. Apr-2026</span>
            </div>
            <div className="ei-field">
              <span className="ei-label">Segment</span>
              <select value={mktF.segment} onChange={e=>setMktF(f=>({...f,segment:e.target.value}))}>
                {["DRAM","NAND","Logic","WFE_total","HBM","Generic"].map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="ei-row" style={{ marginBottom:10 }}>
            <div className="ei-field">
              <span className="ei-label">Metric</span>
              <select value={mktF.metric} onChange={e=>setMktF(f=>({...f,metric:e.target.value}))}>
                {["revenue_growth_yoy","capex_growth_yoy","wafer_starts_growth","revenue_qoq","capex_qoq"].map(s=><option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
              </select>
            </div>
            <div className="ei-field">
              <span className="ei-label">Value (%)</span>
              <input type="text" inputMode="decimal" value={mktF.value}
                onChange={e=>setMktF(f=>({...f,value:e.target.value}))}
                placeholder="35.0" autoComplete="off" autoCorrect="off"/>
              <span className="ei-hint">percentage — e.g. 35 means +35%</span>
            </div>
          </div>
          <div className="ei-row" style={{ marginBottom:12 }}>
            <div className="ei-field" style={{ gridColumn:"1/-1" }}>
              <span className="ei-label">Notes (optional)</span>
              <input type="text" value={mktF.notes} onChange={e=>setMktF(f=>({...f,notes:e.target.value}))}
                placeholder="context" autoComplete="off"/>
            </div>
          </div>
          <button className="ei-save" disabled={saving} onClick={saveMkt}>{saving?"Saving…":"Save"}</button>
        </div>

        {marketData.length===0
          ? <div className="ei-empty">No market data yet</div>
          : Object.entries(byPeriod(marketData)).map(([period,rows])=>(
            <div key={period} className="ei-period-block">
              <div className="ei-period-hdr">
                <span className="ei-period-lbl">{period}</span>
              </div>
              <div className="ei-card-grid">
                {rows.map(r=>(
                  <div key={r.id} className="ei-card">
                    <div className="ei-card-lbl">{r.segment}</div>
                    <div style={{ fontSize:10, color:"#333", marginBottom:6 }}>{r.metric.replace(/_/g," ")}</div>
                    <div style={{ fontFamily:"monospace", fontSize:24, fontWeight:700, color:r.value>0?"#00e5a0":"#ff6b6b" }}>
                      {r.value>0?"+":""}{r.value}%
                    </div>
                    {r.notes && <div style={{ fontSize:10, color:"#333", marginTop:6, fontStyle:"italic" }}>{r.notes}</div>}
                    <div className="ei-actions">
                      <button className="ei-btn-edit" onClick={()=>setMktF({ period:r.period, segment:r.segment, metric:r.metric, value:String(r.value), notes:r.notes||"" })}>✎ Edit</button>
                      <button className="ei-btn-del" onClick={async()=>{ await SB.from("edge_intel_market").delete().eq("id",r.id); load(); }}>✕ Del</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        }
      </div>}

      {/* ════ CAPEX ════ */}
      {section==="capex" && <div className="ei-section">
        <div className="ei-form">
          <div className="ei-form-title">💰 Capex by Company</div>
          <div className="ei-row">
            <div className="ei-field">
              <span className="ei-label">Period</span>
              <input type="text" value={capF.period} onChange={e=>setCapF(f=>({...f,period:e.target.value}))}
                placeholder="Q2-2026" autoComplete="off" autoCorrect="off"/>
              <span className="ei-hint">e.g. Q2-2026</span>
            </div>
            <div className="ei-field">
              <span className="ei-label">Company</span>
              <select value={capF.company} onChange={e=>setCapF(f=>({...f,company:e.target.value}))}>
                {["TSMC","Samsung","SK_Hynix","Micron","Intel","ASML_customer_total"].map(s=><option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
              </select>
            </div>
          </div>
          <div className="ei-row" style={{ marginBottom:10 }}>
            <div className="ei-field">
              <span className="ei-label">Capex ($B)</span>
              <input type="text" inputMode="decimal" value={capF.capex_usd_b}
                onChange={e=>setCapF(f=>({...f,capex_usd_b:e.target.value}))}
                placeholder="8.5" autoComplete="off" autoCorrect="off"/>
            </div>
            <div className="ei-field">
              <span className="ei-label">YoY Growth %</span>
              <input type="text" inputMode="decimal" value={capF.capex_growth_yoy}
                onChange={e=>setCapF(f=>({...f,capex_growth_yoy:e.target.value}))}
                placeholder="+35" autoComplete="off" autoCorrect="off"/>
            </div>
            <div className="ei-field">
              <span className="ei-label">Primary Use</span>
              <select value={capF.primary_use} onChange={e=>setCapF(f=>({...f,primary_use:e.target.value}))}>
                {["EUV_ramp","DRAM_HBM","Logic_advanced","NAND","Legacy_DUV","Mixed"].map(s=><option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
              </select>
            </div>
          </div>
          <div className="ei-row" style={{ marginBottom:12 }}>
            <div className="ei-field" style={{ gridColumn:"1/-1" }}>
              <span className="ei-label">Notes (optional)</span>
              <input type="text" value={capF.notes} onChange={e=>setCapF(f=>({...f,notes:e.target.value}))}
                placeholder="optional" autoComplete="off"/>
            </div>
          </div>
          <button className="ei-save" disabled={saving} onClick={saveCap}>{saving?"Saving…":"Save"}</button>
        </div>

        {capexData.length===0
          ? <div className="ei-empty">No capex data yet</div>
          : Object.entries(byPeriod(capexData)).map(([period,rows])=>(
            <div key={period} className="ei-period-block">
              <div className="ei-period-hdr">
                <span className="ei-period-lbl">{period}</span>
              </div>
              <div className="ei-card-grid">
                {rows.map(r=>(
                  <div key={r.id} className="ei-card">
                    <div style={{ fontSize:13, fontWeight:700, color:"#e0e0e0", marginBottom:2 }}>{r.company.replace(/_/g," ")}</div>
                    <div style={{ fontSize:10, color:"#333", marginBottom:8 }}>{r.primary_use?.replace(/_/g," ")}</div>
                    {r.capex_usd_b!=null && <div style={{ fontFamily:"monospace", fontSize:22, fontWeight:700, color:"#888" }}>${r.capex_usd_b}B</div>}
                    {r.capex_growth_yoy!=null && (
                      <div style={{ fontFamily:"monospace", fontSize:14, fontWeight:700, color:r.capex_growth_yoy>0?"#00e5a0":"#ff6b6b", marginTop:2 }}>
                        {r.capex_growth_yoy>0?"+":""}{r.capex_growth_yoy}% YoY
                      </div>
                    )}
                    {r.notes && <div style={{ fontSize:10, color:"#333", marginTop:6, fontStyle:"italic" }}>{r.notes}</div>}
                    <div className="ei-actions">
                      <button className="ei-btn-edit" onClick={()=>setCapF({ period:r.period, company:r.company, capex_usd_b:r.capex_usd_b!=null?String(r.capex_usd_b):"", capex_growth_yoy:r.capex_growth_yoy!=null?String(r.capex_growth_yoy):"", primary_use:r.primary_use||"EUV_ramp", notes:r.notes||"" })}>✎ Edit</button>
                      <button className="ei-btn-del" onClick={async()=>{ await SB.from("edge_intel_capex").delete().eq("id",r.id); load(); }}>✕ Del</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        }
      </div>}

      {/* ════ TOOL PLAN ════ */}
      {section==="tools" && <div className="ei-section">
        <div className="ei-form">
          <div className="ei-form-title">🔧 ASML Tool Shipment Plan</div>
          <div className="ei-row">
            <div className="ei-field">
              <span className="ei-label">Quarter</span>
              <input type="text" value={toolF.period} onChange={e=>setToolF(f=>({...f,period:e.target.value}))}
                placeholder="Q2-2026" autoComplete="off" autoCorrect="off"/>
              <span className="ei-hint">e.g. Q2-2026</span>
            </div>
            <div className="ei-field">
              <span className="ei-label">Tool Type</span>
              <select value={toolF.tool_type} onChange={e=>setToolF(f=>({...f,tool_type:e.target.value}))}>
                {["DUV","NXE_low_NA","NXE_high_NA","EXE"].map(s=><option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
              </select>
            </div>
          </div>
          <div className="ei-row" style={{ marginBottom:10 }}>
            <div className="ei-field">
              <span className="ei-label">Units Planned</span>
              <input type="text" inputMode="decimal" value={toolF.units_plan}
                onChange={e=>setToolF(f=>({...f,units_plan:e.target.value}))}
                placeholder="12" autoComplete="off" autoCorrect="off"/>
            </div>
            <div className="ei-field">
              <span className="ei-label">ASP (€M)</span>
              <input type="text" inputMode="decimal" value={toolF.asp_eur_m}
                onChange={e=>setToolF(f=>({...f,asp_eur_m:e.target.value}))}
                autoComplete="off" autoCorrect="off"/>
              <span className="ei-hint">Auto: DUV €45M · NXE €230M · EXE €380M</span>
            </div>
            <div className="ei-field">
              <span className="ei-label">Implied Revenue</span>
              <div className="ei-display">€{impliedRev.toFixed(0)}M</div>
            </div>
          </div>
          <div className="ei-row" style={{ marginBottom:12 }}>
            <div className="ei-field" style={{ gridColumn:"1/-1" }}>
              <span className="ei-label">Notes (optional)</span>
              <input type="text" value={toolF.notes} onChange={e=>setToolF(f=>({...f,notes:e.target.value}))}
                placeholder="optional" autoComplete="off"/>
            </div>
          </div>
          <button className="ei-save" disabled={saving} onClick={saveTool}>{saving?"Saving…":"Save"}</button>
        </div>

        {toolData.length===0
          ? <div className="ei-empty">No tool plan data yet</div>
          : Object.entries(byPeriod(toolData)).map(([period,rows])=>{
            const total=rows.reduce((s,r)=>s+(r.implied_rev_eur_m||r.units_plan*r.asp_eur_m||0),0);
            return (
              <div key={period} className="ei-period-block">
                <div className="ei-period-hdr">
                  <span className="ei-period-lbl">{period}</span>
                  <span className="ei-period-total">€{total.toFixed(0)}M</span>
                </div>
                <div className="ei-card-grid">
                  {rows.map(r=>{
                    const rev=r.implied_rev_eur_m||(r.units_plan*r.asp_eur_m)||0;
                    const hi=r.tool_type==="EXE"||r.tool_type==="NXE_high_NA";
                    return (
                      <div key={r.id} className="ei-card" style={{ borderColor:hi?"#f5c84233":"#1a1a1a" }}>
                        <div style={{ fontSize:12, fontWeight:700, color:hi?"#f5c842":"#888", marginBottom:4 }}>{r.tool_type.replace(/_/g," ")}</div>
                        <div style={{ fontFamily:"monospace", fontSize:24, fontWeight:700, color:"#e0e0e0" }}>{r.units_plan}</div>
                        <div style={{ fontSize:11, color:"#444", marginBottom:4 }}>units</div>
                        <div style={{ fontFamily:"monospace", fontSize:14, color:"#00e5a0" }}>€{rev.toFixed(0)}M</div>
                        <div style={{ fontSize:9, color:"#2a2a2a", marginTop:2 }}>@ €{r.asp_eur_m}M/unit</div>
                        {r.notes && <div style={{ fontSize:10, color:"#333", marginTop:6, fontStyle:"italic" }}>{r.notes}</div>}
                        <div className="ei-actions">
                          <button className="ei-btn-edit" onClick={()=>setToolF({ period:r.period, tool_type:r.tool_type, units_plan:String(r.units_plan), asp_eur_m:String(r.asp_eur_m), notes:r.notes||"" })}>✎ Edit</button>
                          <button className="ei-btn-del" onClick={async()=>{ await SB.from("edge_intel_asml_tools").delete().eq("id",r.id); load(); }}>✕ Del</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        }
      </div>}

      {/* ════ ASML CALC ════ */}
      {section==="calc" && <div className="ei-section">
        <div className="ei-form accent-green" style={{ borderColor:"#00e5a022" }}>
          <div className="ei-form-title green">📐 ASML Implied Revenue</div>
          <div style={{ fontSize:12, color:"#444", lineHeight:1.7 }}>
            Tool revenue + 28% installed base × 53% gross margin → implied annual EPS.
            After calculating, add a ⚡ Growth Signal to feed it into Valuation.
          </div>
        </div>

        {Object.keys(asmlQ).length===0
          ? <div className="ei-empty">Add tool plan data first (🔧 Tool Plan)</div>
          : Object.values(asmlQ).map(q=>{
              const ib=q.total*0.28, qRev=q.total+ib, aRev=qRev*4;
              const aGP=aRev*0.53, netInc=aGP*0.83*0.83, eps=netInc/405;
              return (
                <div key={q.period} className="ei-period-block">
                  <div className="ei-period-hdr">
                    <span className="ei-period-lbl">{q.period}</span>
                    <span style={{ fontFamily:"monospace", fontSize:14, fontWeight:700, color:eps>30?"#00e5a0":"#f5c842" }}>€{eps.toFixed(0)} EPS/yr</span>
                  </div>
                  <div className="ei-card-grid">
                    {[
                      ["Tool revenue (quarterly)", `€${q.total.toFixed(0)}M`, "#888"],
                      ["+ Installed base (28%)", `€${ib.toFixed(0)}M`, "#555"],
                      ["= Quarterly total", `€${qRev.toFixed(0)}M`, "#e0e0e0"],
                      ["Annualised (×4)", `€${(aRev/1000).toFixed(1)}B`, "#f5c842"],
                      ["Gross profit (53%)", `€${(aGP/1000).toFixed(1)}B`, "#888"],
                      ["Implied EPS / yr", `€${eps.toFixed(0)}`, eps>30?"#00e5a0":"#f5c842"],
                    ].map(([lbl,val,color])=>(
                      <div key={lbl} className="ei-card">
                        <div className="ei-card-lbl">{lbl}</div>
                        <div className="ei-card-val" style={{ color }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop:10, display:"flex", gap:6, flexWrap:"wrap" }}>
                    {q.items.map(b=>(
                      <div key={b.type} style={{ fontSize:11, color:"#444", background:"#0c0c0c", borderRadius:6, padding:"6px 12px", fontFamily:"monospace", border:"1px solid #1a1a1a" }}>
                        {b.type.replace(/_/g," ")}: {b.units}u × €{b.asp}M = <span style={{ color:"#00e5a0" }}>€{b.rev.toFixed(0)}M</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop:10, fontSize:11, color:"#2a2a2a", lineHeight:1.7 }}>
                    Model: tool rev + 28% installed base × 53% GM × 83% EBIT × 83% net ÷ 405M shares. Go to ⚡ Signals to feed into Valuation.
                  </div>
                </div>
              );
            })
        }
      </div>}
    </div>
  );
}

function MarktTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fgHistory, setFgHistory] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      // Fetch main market data + SOX in parallel
      const [r, soxR] = await Promise.all([
        fetch("/api/market"),
        fetch("/api/yahoo?symbol=%5ESOX&endpoint=quoteSummary&modules=summaryDetail,defaultKeyStatistics"),
      ]);
      const d = await r.json();
      // Enrich with SOX data
      try {
        const soxJson = await soxR.json();
        const sd = soxJson?.quoteSummary?.result?.[0]?.summaryDetail;
        if (sd) {
          d.sox = sd.regularMarketPrice?.raw ?? sd.previousClose?.raw;
          d.soxChange = sd.regularMarketChangePercent?.raw != null
            ? sd.regularMarketChangePercent.raw * 100
            : null;
          d.sox52wHigh = sd.fiftyTwoWeekHigh?.raw;
          d.sox52wLow = sd.fiftyTwoWeekLow?.raw;
          d.sox200dma = sd.twoHundredDayAverage?.raw;
        }
      } catch(e2) { /* SOX optional */ }
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
    // Load Fear & Greed history from market_snapshots
    try {
      const { data: snap } = await SB.from("market_snapshots")
        .select("date, fear_greed, vix, sp500_price")
        .not("fear_greed", "is", null)
        .order("date", { ascending: true })
        .limit(60);
      if (snap?.length) setFgHistory(snap.map(r => ({
        date: r.date.slice(5), // "MM-DD"
        fg: r.fear_greed,
        vix: parseFloat(r.vix),
        sp500: parseFloat(r.sp500_price),
      })));
    } catch(e) { /* silent */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const soxSignal = (sox, sox200dma) => {
    if (!sox || !sox200dma) return ["—", "#444", "No data"];
    const pct = ((sox - sox200dma) / sox200dma) * 100;
    if (pct > 20) return ["EXTENDED", "#ff6b6b", `+${pct.toFixed(1)}% above 200DMA — semicons overbought`];
    if (pct > 5)  return ["ABOVE 200D", "#f5c842", `+${pct.toFixed(1)}% above 200DMA — healthy uptrend`];
    if (pct > -5) return ["AT 200D", "#00e5a0", `${pct.toFixed(1)}% vs 200DMA — near fair value`];
    if (pct > -15) return ["BELOW 200D", "#7be0c0", `${pct.toFixed(1)}% below 200DMA — potential value zone`];
    return ["OVERSOLD", "#00e5a0", `${pct.toFixed(1)}% below 200DMA — historically strong buy signal for semicons`];
  };

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
    if (data.sox && data.sox200dma) {
      const soxVs200 = (data.sox - data.sox200dma) / data.sox200dma;
      score += soxVs200 < -0.10 ? 2 : soxVs200 < -0.05 ? 1 : soxVs200 > 0.20 ? -1 : 0;
      factors++;
    }
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
  const [soxLabel, soxColor, soxDesc] = soxSignal(data?.sox, data?.sox200dma);

  return (
    <div>
      {/* Overall signal */}
      {overall && (
        <div style={{ background: overall[1] + "11", border: `1px solid ${overall[1]}33`, borderRadius: 12, padding: "16px", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <span style={{ fontSize: 26 }}>
              {overall[0].includes("STRONG") ? "🟢" : overall[0].includes("MODERATE") ? "🟡" : overall[0].includes("NEUTRAL") ? "🟡" : "🔴"}
            </span>
            <span style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: overall[1], flex: 1 }}>{overall[0]}</span>
            <span style={{ fontSize: 10, color: "#2a2a2a", fontFamily: "monospace", flexShrink: 0 }}>
              {lastUpdated ? lastUpdated.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : ""}
            </span>
            <button onClick={load} disabled={loading} style={{ background: "transparent", border: "1px solid #222", borderRadius: 8, color: loading ? "#2a2a2a" : "#555", padding: "6px 10px", cursor: "pointer", display: "flex", alignItems: "center", flexShrink: 0 }}>
              {loading ? <Spinner/> : <Icon name="refresh" size={13}/>}
            </button>
          </div>
          <div style={{ fontSize: 12, color: "#555", paddingLeft: 38 }}>{overall[2]}</div>
        </div>
      )}

      {loading && !data ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#333", fontFamily: "monospace", padding: "40px 0" }}><Spinner/> Loading market data…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Rij 1: VIX + Fear & Greed */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* VIX */}
            <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12 }}>VIX — Volatility Index</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                <span style={{ fontFamily: "monospace", fontSize: 28, fontWeight: 700, color: vColor }}>{data?.vix?.toFixed(1) || "—"}</span>
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
            <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12 }}>Fear & Greed Index — CNN</div>
              {data?.fearGreed ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 28, fontWeight: 700, color: fgColor }}>{data.fearGreed.score}</span>
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

          </div>{/* end rij 1 */}

          {/* ── SOX + AAII row ── */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>

            {/* SOX — Philadelphia Semiconductor Index */}
            <div style={{ background:"#070707", border:"1px solid #141414", borderRadius:12, padding:"14px 16px" }}>
              <div style={{ fontSize:10, color:"#444", textTransform:"uppercase", letterSpacing:1.2, marginBottom:12 }}>
                SOX — Semicon Index
              </div>
              {data?.sox ? (
                <>
                  <div style={{ display:"flex", alignItems:"baseline", gap:10, marginBottom:8 }}>
                    <span style={{ fontFamily:"monospace", fontSize:26, fontWeight:700, color:soxColor }}>
                      {data.sox.toFixed(0)}
                    </span>
                    {data.soxChange != null && (
                      <span style={{ fontFamily:"monospace", fontSize:13, color:data.soxChange>=0?"#00e5a0":"#ff6b6b" }}>
                        {data.soxChange>=0?"+":""}{data.soxChange.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div style={{ display:"inline-block", background:soxColor+"22", border:`1px solid ${soxColor}44`,
                    borderRadius:5, padding:"3px 10px", fontSize:11, fontWeight:700, color:soxColor,
                    fontFamily:"monospace", marginBottom:10 }}>{soxLabel}</div>

                  {/* 52W range bar */}
                  {data.sox52wLow && data.sox52wHigh && (() => {
                    const pct = Math.min(98, Math.max(2,
                      ((data.sox - data.sox52wLow) / (data.sox52wHigh - data.sox52wLow)) * 100));
                    return (
                      <div style={{ marginBottom:10 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                          <span style={{ fontSize:9, color:"#2a2a2a", fontFamily:"monospace" }}>52W L: {data.sox52wLow?.toFixed(0)}</span>
                          <span style={{ fontSize:9, color:"#555", fontFamily:"monospace" }}>52W H: {data.sox52wHigh?.toFixed(0)}</span>
                        </div>
                        <div style={{ height:5, borderRadius:3, background:"#1a1a1a", position:"relative" }}>
                          <div style={{ position:"absolute", left:0, top:0, height:"100%", width:`${pct}%`,
                            background:`linear-gradient(to right, #00e5a0, ${soxColor})`, borderRadius:3 }}/>
                          <div style={{ position:"absolute", left:`${pct}%`, top:-3, width:3, height:11,
                            background:"#fff", borderRadius:2, transform:"translateX(-50%)" }}/>
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ fontSize:11, color:"#444", lineHeight:1.6 }}>{soxDesc}</div>

                  {/* 200DMA reference */}
                  {data.sox200dma && (
                    <div style={{ marginTop:8, fontSize:10, color:"#2a2a2a" }}>
                      200DMA: <span style={{ fontFamily:"monospace", color:"#555" }}>{data.sox200dma.toFixed(0)}</span>
                    </div>
                  )}

                  {/* Uitleg */}
                  <div style={{ marginTop:12, padding:"10px 12px", background:"#0d0d0d", borderRadius:8, border:"1px solid #1a1a1a" }}>
                    <div style={{ fontSize:10, color:"#333", fontWeight:700, textTransform:"uppercase", letterSpacing:0.7, marginBottom:6 }}>
                      Waarom SOX voor jouw portfolio?
                    </div>
                    <div style={{ fontSize:11, color:"#2a2a2a", lineHeight:1.7 }}>
                      SOX meet direct het sentiment in halfgeleiders — jouw portfolio is ~50% semi's.
                      Als SOX >20% boven 200DMA staat, is de sector overbought en verhoog je het risico op een correctie.
                      Onder de 200DMA is historisch het beste koopmoment voor ASML, TSM en MU.
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ color:"#333", fontSize:12 }}>SOX data laden…</div>
              )}
            </div>

            {/* AAII Sentiment — handmatig invoeren (geen publieke API) */}
            <div style={{ background:"#070707", border:"1px solid #141414", borderRadius:12, padding:"14px 16px" }}>
              <div style={{ fontSize:10, color:"#444", textTransform:"uppercase", letterSpacing:1.2, marginBottom:12 }}>
                AAII Sentiment — wekelijks
              </div>

              {/* Static display — user updates manually each Thursday */}
              <div style={{ marginBottom:12 }}>
                <div style={{ fontSize:10, color:"#333", marginBottom:6 }}>Laatste survey (elke donderdag)</div>
                <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                  {[
                    { label:"Bullish", pct: data?.aaii?.bull ?? 32, color:"#00e5a0", avg:37.5 },
                    { label:"Neutral", pct: data?.aaii?.neutral ?? 33, color:"#f5c842", avg:31.5 },
                    { label:"Bearish", pct: data?.aaii?.bear ?? 35, color:"#ff6b6b", avg:31.0 },
                  ].map(s => (
                    <div key={s.label} style={{ flex:1, textAlign:"center" }}>
                      <div style={{ fontSize:9, color:"#333", marginBottom:4, textTransform:"uppercase", letterSpacing:0.5 }}>{s.label}</div>
                      <div style={{ fontFamily:"monospace", fontSize:20, fontWeight:700, color:s.color }}>{s.pct}%</div>
                      <div style={{ fontSize:8, color:"#2a2a2a", marginTop:2 }}>avg {s.avg}%</div>
                      {/* Bar */}
                      <div style={{ height:3, background:"#1a1a1a", borderRadius:2, marginTop:4, position:"relative" }}>
                        <div style={{ height:"100%", width:`${s.pct}%`, background:s.color, borderRadius:2, opacity:0.6 }}/>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Bull-Bear spread */}
                {(() => {
                  const bull = data?.aaii?.bull ?? 32;
                  const bear = data?.aaii?.bear ?? 35;
                  const spread = bull - bear;
                  const spreadColor = spread > 10 ? "#ff9966" : spread < -10 ? "#00e5a0" : "#f5c842";
                  return (
                    <div style={{ padding:"8px 10px", background:"#0a0a0a", borderRadius:6, border:`1px solid ${spreadColor}22`, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:"#444" }}>Bull-Bear spread: </span>
                      <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:spreadColor }}>
                        {spread > 0 ? "+" : ""}{spread}%
                      </span>
                      <span style={{ fontSize:10, color:"#333", marginLeft:8 }}>
                        {spread < -10 ? "Historisch koopsignaal (bearishness piek)" :
                         spread > 10 ? "Voorzichtig — hoge bullishness = contrarian waarschuwing" :
                         "Neutraal sentiment"}
                      </span>
                    </div>
                  );
                })()}
              </div>

              {/* Uitleg */}
              <div style={{ padding:"10px 12px", background:"#0d0d0d", borderRadius:8, border:"1px solid #1a1a1a", marginBottom:10 }}>
                <div style={{ fontSize:10, color:"#333", fontWeight:700, textTransform:"uppercase", letterSpacing:0.7, marginBottom:6 }}>
                  Wat is AAII en waarom relevant?
                </div>
                <div style={{ fontSize:11, color:"#2a2a2a", lineHeight:1.7 }}>
                  <strong style={{ color:"#444" }}>AAII</strong> = American Association of Individual Investors.
                  Wekelijkse enquête (1987–nu) onder +160.000 leden: bull/neutral/bear voor de komende 6 maanden.
                  Het is een <strong style={{ color:"#555" }}>contrarian indicator</strong> — extreme bearishness (&lt;20% bull)
                  correleert historisch met marktbodems. Extreme bullishness (&gt;55%) met pieken.
                  <br/><br/>
                  <strong style={{ color:"#444" }}>Historisch gemiddelde:</strong> 37.5% bull · 31.5% neutral · 31% bear.
                  Een bull-bear spread onder -20% is een van de sterkste koopsignalen in de markt.
                </div>
              </div>

              <div style={{ fontSize:10, color:"#2a2a2a", fontStyle:"italic" }}>
                ⓘ Update elke donderdag via <span style={{ color:"#444" }}>aaii.com/sentimentsurvey</span>
              </div>
            </div>
          </div>{/* end SOX + AAII row */}

          {/* ── Fear & Greed History Chart ── */}
          {fgHistory.length > 1 && (
            <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "16px", marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1.2 }}>
                  Fear & Greed — {fgHistory.length} dag trend
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 9, color: "#333", fontFamily: "monospace" }}>
                  <span style={{ color: "#00e5a0" }}>● Fear (&lt;45)</span>
                  <span style={{ color: "#f5c842" }}>● Neutral (45-55)</span>
                  <span style={{ color: "#ff6b6b" }}>● Greed (&gt;55)</span>
                </div>
              </div>

              {/* SVG line chart */}
              {(() => {
                const W = 600, H = 110, PAD = { t: 16, r: 32, b: 8, l: 28 };
                const iW = W - PAD.l - PAD.r;
                const iH = H - PAD.t - PAD.b;
                const n = fgHistory.length;
                const xOf = i => PAD.l + (i / (n - 1)) * iW;
                const yOf = v => PAD.t + iH - ((v / 100) * iH);
                const pts = fgHistory.map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.fg).toFixed(1)}`).join(" ");
                const fillPts = `${xOf(0).toFixed(1)},${(PAD.t+iH).toFixed(1)} ${pts} ${xOf(n-1).toFixed(1)},${(PAD.t+iH).toFixed(1)}`;
                const dotColor = d => d.fg <= 25 ? "#00e5a0" : d.fg <= 45 ? "#7be0c0" : d.fg <= 55 ? "#f5c842" : d.fg <= 75 ? "#ff9966" : "#ff6b6b";
                const y75 = yOf(75), y55 = yOf(55), y25 = yOf(25);
                const last = fgHistory[n-1];
                const lx = xOf(n-1), ly = yOf(last.fg);
                const lc = dotColor(last);
                return (
                  <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height: 130, overflow:"visible" }}>
                    <defs>
                      <linearGradient id="fgFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={lc} stopOpacity="0.3"/>
                        <stop offset="100%" stopColor={lc} stopOpacity="0.02"/>
                      </linearGradient>
                    </defs>

                    {/* Zone reference lines */}
                    <line x1={PAD.l} y1={y75} x2={W-PAD.r} y2={y75} stroke="#ff6b6b" strokeWidth="0.5" strokeDasharray="4,4" strokeOpacity="0.3"/>
                    <line x1={PAD.l} y1={y55} x2={W-PAD.r} y2={y55} stroke="#f5c842" strokeWidth="0.5" strokeDasharray="4,4" strokeOpacity="0.3"/>
                    <line x1={PAD.l} y1={y25} x2={W-PAD.r} y2={y25} stroke="#00e5a0" strokeWidth="0.5" strokeDasharray="4,4" strokeOpacity="0.3"/>

                    {/* Zone labels */}
                    <text x={PAD.l-4} y={y75+3} fontSize="7" fill="#ff6b6b" opacity="0.5" textAnchor="end">75</text>
                    <text x={PAD.l-4} y={y55+3} fontSize="7" fill="#f5c842" opacity="0.5" textAnchor="end">55</text>
                    <text x={PAD.l-4} y={y25+3} fontSize="7" fill="#00e5a0" opacity="0.5" textAnchor="end">25</text>

                    {/* Fill under line */}
                    <polygon points={fillPts} fill="url(#fgFill)"/>

                    {/* Line */}
                    <polyline points={pts} fill="none" stroke={lc} strokeWidth="1.5" strokeOpacity="0.8" strokeLinejoin="round" strokeLinecap="round"/>

                    {/* Dots */}
                    {fgHistory.map((d, i) => {
                      const x = xOf(i), y = yOf(d.fg), c = dotColor(d);
                      const isLast = i === n - 1;
                      return (
                        <g key={i}>
                          <circle cx={x} cy={y} r={isLast ? 4.5 : 2.5} fill={c} opacity={isLast ? 1 : 0.7}/>
                          {isLast && <circle cx={x} cy={y} r={8} fill={c} opacity="0.15"/>}
                          {/* Show value for last and first */}
                          {(isLast || i === 0 || i === Math.floor(n/2)) && (
                            <text x={x} y={y - 8} fontSize="9" fill={c} textAnchor="middle" fontFamily="monospace" fontWeight={isLast ? "bold" : "normal"}>
                              {d.fg}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                );
              })()}

              {/* X-axis dates — only show a few */}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, paddingRight: 16 }}>
                <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace" }}>{fgHistory[0]?.date}</span>
                {fgHistory.length > 4 && (
                  <span style={{ fontSize: 9, color: "#2a2a2a", fontFamily: "monospace" }}>{fgHistory[Math.floor(fgHistory.length/2)]?.date}</span>
                )}
                <span style={{ fontSize: 9, color: "#555", fontFamily: "monospace", fontWeight: 700 }}>{fgHistory[fgHistory.length-1]?.date} ← vandaag</span>
              </div>

              {/* Summary stats */}
              {fgHistory.length >= 3 && (() => {
                const recent5 = fgHistory.slice(-5);
                const avg5 = recent5.reduce((s,d) => s+d.fg, 0) / recent5.length;
                const min = Math.min(...fgHistory.map(d=>d.fg));
                const max = Math.max(...fgHistory.map(d=>d.fg));
                const trend = fgHistory[fgHistory.length-1].fg - fgHistory[fgHistory.length-3].fg;
                return (
                  <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                    {[
                      ["5D gemiddelde", avg5.toFixed(0), avg5 < 45 ? "#7be0c0" : avg5 < 55 ? "#f5c842" : "#ff9966"],
                      ["Periode min", min, "#00e5a0"],
                      ["Periode max", max, "#ff6b6b"],
                      ["2D trend", `${trend > 0 ? "+" : ""}${trend}`, trend > 5 ? "#ff9966" : trend < -5 ? "#00e5a0" : "#555"],
                    ].map(([label, val, color]) => (
                      <div key={label}>
                        <div style={{ fontSize: 9, color: "#333", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 2 }}>{label}</div>
                        <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color }}>{val}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Rij 2: S&P500, Treasury, DXY */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
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
              <div key={item.label} style={{ background: "#070707", border: "1px solid #141414", borderRadius: 12, padding: "14px 14px" }}>
                <div style={{ fontSize: 9, color: "#444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{item.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 700, color: item.color }}>{item.value}</span>
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
          <div style={{ background: "#070707", border: "1px solid #1a1a1a", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>Market context for entry decisions</div>
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

                data?.sox && data?.sox200dma && (() => {
                  const pct = ((data.sox - data.sox200dma) / data.sox200dma * 100).toFixed(1);
                  if (data.sox < data.sox200dma * 0.90)
                    return { signal: "✅", text: `SOX ${pct}% onder 200DMA — semicons in historische koopzone. Jouw portfolio profiteert het meest van dit soort correcties.`, color: "#00e5a0" };
                  if (data.sox > data.sox200dma * 1.20)
                    return { signal: "⚠️", text: `SOX ${pct}% boven 200DMA — semicons extended. Verhoog voorzichtigheid met nieuwe semicon posities.`, color: "#ff6b6b" };
                  return { signal: "➡️", text: `SOX ${pct}% vs 200DMA — semicons in normale range.`, color: "#888" };
                })(),

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

// ── Valuation Tracker Tab ────────────────────────────────────────────────────
function ValuationTrackerTab() {
  const [rows, setRows]         = useState([]);
  const [status, setStatus]     = useState("Laden...");
  const [loading, setLoading]   = useState(true);
  const [updated, setUpdated]   = useState(null);
  const [sortBy, setSortBy]     = useState("pct_base");
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    setLoading(true);
    setStatus("Configs laden...");

    // Step 1: configs from DB
    const { data: cfgs } = await SB
      .from("valuation_config")
      .select("symbol,eps_basis,pe_bear_abs,pe_base_abs,pe_bull_abs,note")
      .neq("symbol", "DEFAULT")
      .not("pe_base_abs", "is", null);

    if (!cfgs?.length) { setStatus("Geen configs gevonden"); setLoading(false); return; }
    setStatus(`Prijzen ophalen voor ${cfgs.length} stocks...`);

    // Step 2: fetch prices using existing fetchFull (proven to work in ValuationTab)
    const results = [];
    for (const cfg of cfgs) {
      try {
        // Fetch price + EPS in parallel using proven functions
        const [full, sumRaw] = await Promise.all([
          fetchFull(cfg.symbol),
          yahooSummary(cfg.symbol),
        ]);
        if (!full || !full.price) { console.log(`No price for ${cfg.symbol}`); continue; }
        const price  = full.price;
        const fin2   = sumRaw?.quoteSummary?.result?.[0];
        const ks2    = fin2?.defaultKeyStatistics ?? {};
        const fwdEPS = ks2.forwardEps?.raw  ?? null;
        const trlEPS = ks2.trailingEps?.raw ?? null;

        // Choose EPS per config
        const distorted = fwdEPS && trlEPS && trlEPS > 0 && fwdEPS > trlEPS * 4;
        let baseEPS, epsLabel;
        if (cfg.eps_basis === "forward" && fwdEPS && fwdEPS > 0 && !distorted) {
          baseEPS = fwdEPS; epsLabel = `fwd $${fwdEPS.toFixed(2)}`;
        } else if (trlEPS && trlEPS > 0) {
          baseEPS = trlEPS; epsLabel = `trl $${trlEPS.toFixed(2)}`;
        } else {
          console.log(`No EPS for ${cfg.symbol}`); continue;
        }

        const bearPE = Number(cfg.pe_bear_abs);
        const basePE = Number(cfg.pe_base_abs);
        const bullPE = Number(cfg.pe_bull_abs);

        const bearP = Math.round(baseEPS * bearPE);
        const baseP = Math.round(baseEPS * basePE);
        const bullP = Math.round(baseEPS * bullPE);

        const pctBase = Math.round(((price - baseP) / baseP) * 100);
        const range   = bullP - bearP;
        const barPct  = range > 0
          ? Math.min(96, Math.max(4, ((price - bearP) / range) * 100))
          : 50;

        let zone, zc;
        if      (price <= bearP)        { zone="DEEP VALUE"; zc="#00e5a0"; }
        else if (price <= baseP * 0.95) { zone="BUY ZONE";  zc="#7be0c0"; }
        else if (price <= baseP * 1.05) { zone="FAIR";      zc="#f5c842"; }
        else if (price <= bullP)        { zone="PREMIUM";   zc="#ff9966"; }
        else                            { zone="EXPENSIVE"; zc="#ff6b6b"; }

        results.push({
          symbol:cfg.symbol, price, baseEPS, epsLabel,
          bearPE, basePE, bullPE, bearP, baseP, bullP,
          pctBase, barPct, zone, zc,
          change: full.change ?? 0,
          note: cfg.note ?? "",
        });
        setStatus(`Geladen: ${results.length}/${cfgs.length}`);
      } catch(e) { console.warn(`Skip ${cfg.symbol}:`, e); }
      await new Promise(r => setTimeout(r, 120));
    }

    setRows(results);
    setUpdated(new Date());
    setStatus(`${results.length} stocks geladen`);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const sorted = [...rows].sort((a, b) =>
    sortBy === "symbol"   ? a.symbol.localeCompare(b.symbol) :
    sortBy === "zone"     ? a.barPct - b.barPct :
    a.pctBase - b.pctBase
  );

  const thS = {
    padding:"9px 12px", textAlign:"left", fontSize:10, color:"#444",
    fontWeight:700, textTransform:"uppercase", letterSpacing:0.8,
    borderBottom:"1px solid #111", whiteSpace:"nowrap",
  };
  const tdS = {
    padding:"10px 12px", borderBottom:"1px solid #0d0d0d",
    fontFamily:"monospace", fontSize:13, whiteSpace:"nowrap",
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:18, fontWeight:700, color:"#e0e0e0", marginBottom:3 }}>
            📊 Valuation Tracker
          </div>
          <div style={{ fontSize:11, color:"#444" }}>
            {status}
            {updated && !loading && <span style={{ color:"#2a2a2a", marginLeft:10 }}>
              · {updated.toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"})}
            </span>}
          </div>
        </div>
        <button onClick={load} disabled={loading} style={{
          background:"#0c0c0c", border:"1px solid #1a1a1a", borderRadius:9,
          color: loading ? "#444" : "#888", padding:"9px 16px", fontSize:12,
          cursor: loading ? "default" : "pointer",
          display:"flex", alignItems:"center", gap:8, minHeight:40,
        }}>
          {loading ? <><Spinner size={12}/> Laden…</> : "↻ Ververs"}
        </button>
      </div>

      {/* Zone pills */}
      {rows.length > 0 && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
          {[["DEEP VALUE","#00e5a0"],["BUY ZONE","#7be0c0"],["FAIR","#f5c842"],["PREMIUM","#ff9966"],["EXPENSIVE","#ff6b6b"]].map(([z,c]) => {
            const n = rows.filter(r => r.zone === z).length;
            return n > 0 ? (
              <div key={z} style={{ background:`${c}18`, border:`1px solid ${c}44`,
                borderRadius:6, padding:"3px 12px", fontSize:10, color:c, fontWeight:700 }}>
                {n}× {z}
              </div>
            ) : null;
          })}
        </div>
      )}

      {/* Sort */}
      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
        {[["pct_base","Goedkoopste eerst"],["symbol","A–Z"],["zone","Band positie"]].map(([id,lbl]) => (
          <button key={id} onClick={() => setSortBy(id)} style={{
            padding:"5px 12px", borderRadius:6, border:"1px solid",
            borderColor: sortBy===id ? "#00e5a066" : "#1a1a1a",
            background: sortBy===id ? "#00e5a011" : "#0c0c0c",
            color: sortBy===id ? "#00e5a0" : "#444",
            fontSize:11, cursor:"pointer",
          }}>{lbl}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display:"flex", alignItems:"center", gap:10, color:"#333",
          fontFamily:"monospace", padding:"30px 0" }}>
          <Spinner/> {status}
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ color:"#555", padding:"30px 0", textAlign:"center", fontSize:13 }}>
          Geen data beschikbaar — probeer te verversen
        </div>
      ) : (
        <div style={{ overflowX:"auto", borderRadius:10, border:"1px solid #111" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", background:"#070707" }}>
            <thead>
              <tr style={{ background:"#0a0a0a" }}>
                <th style={thS} onClick={() => setSortBy("symbol")} title="Sorteer A-Z">Stock</th>
                <th style={thS}>Zone</th>
                <th style={thS}>Prijs</th>
                <th style={{ ...thS, color:"#ff6b6b55" }}>Bear</th>
                <th style={{ ...thS, color:"#f5c842" }}>Fair ★</th>
                <th style={{ ...thS, color:"#00e5a055" }}>Bull</th>
                <th style={thS} onClick={() => setSortBy("pct_base")} title="Sorteer goedkoopste eerst">vs Fair {sortBy==="pct_base"?"↑":""}</th>
                <th style={{ ...thS, minWidth:150 }} onClick={() => setSortBy("zone")}>Band</th>
                <th style={thS}>EPS</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const isExp = expanded === r.symbol;
                return (
                  <React.Fragment key={r.symbol}>
                    <tr onClick={() => setExpanded(isExp ? null : r.symbol)}
                      style={{ background: isExp ? "#0b0b0b" : i%2===0 ? "#070707" : "#060606", cursor:"pointer" }}>

                      {/* Symbol */}
                      <td style={{ ...tdS, fontWeight:700, color:"#e0e0e0", fontSize:15 }}>
                        {r.symbol}
                        <span style={{ fontSize:8, color:"#333", marginLeft:5 }}>
                          {isExp ? "▲" : "▼"}
                        </span>
                      </td>

                      {/* Zone */}
                      <td style={tdS}>
                        <span style={{ background:`${r.zc}18`, color:r.zc, borderRadius:5,
                          padding:"2px 9px", fontSize:10, fontWeight:700 }}>
                          {r.zone}
                        </span>
                      </td>

                      {/* Prijs + dagverandering */}
                      <td style={{ ...tdS, color:"#e0e0e0", fontWeight:700 }}>
                        ${r.price.toLocaleString("en-US", {maximumFractionDigits:0})}
                        {r.change !== 0 && (
                          <span style={{ fontSize:10, marginLeft:6,
                            color: r.change >= 0 ? "#00e5a0" : "#ff6b6b" }}>
                            {r.change >= 0 ? "+" : ""}{r.change.toFixed(1)}%
                          </span>
                        )}
                      </td>

                      {/* Bear */}
                      <td style={{ ...tdS, color:"#ff6b6b" }}>
                        ${r.bearP.toLocaleString("en-US")}
                        <span style={{ fontSize:9, color:"#333", marginLeft:4 }}>{r.bearPE}×</span>
                      </td>

                      {/* Fair */}
                      <td style={{ ...tdS, color:"#f5c842", fontWeight:700 }}>
                        ${r.baseP.toLocaleString("en-US")}
                        <span style={{ fontSize:9, color:"#555", marginLeft:4 }}>{r.basePE}×</span>
                      </td>

                      {/* Bull */}
                      <td style={{ ...tdS, color:"#00e5a0" }}>
                        ${r.bullP.toLocaleString("en-US")}
                        <span style={{ fontSize:9, color:"#333", marginLeft:4 }}>{r.bullPE}×</span>
                      </td>

                      {/* vs Fair */}
                      <td style={{ ...tdS, fontWeight:700,
                        color: r.pctBase<=-10 ? "#00e5a0" : r.pctBase<=5 ? "#f5c842" : r.pctBase<=25 ? "#ff9966" : "#ff6b6b" }}>
                        {r.pctBase>0?"+":""}{r.pctBase}%
                      </td>

                      {/* Band bar */}
                      <td style={{ ...tdS, minWidth:150 }}>
                        <div style={{ position:"relative", height:20 }}>
                          <div style={{ position:"absolute", top:7, left:0, width:"100%",
                            height:6, borderRadius:3,
                            background:"linear-gradient(to right,#00e5a044,#f5c84222 50%,#ff6b6b33)" }}/>
                          <div style={{ position:"absolute", top:5, left:"50%",
                            width:1.5, height:10, background:"#f5c842aa" }}/>
                          <div style={{ position:"absolute", top:4, left:`${r.barPct}%`,
                            transform:"translateX(-50%)", width:12, height:12,
                            borderRadius:3, background:r.zc }}/>
                        </div>
                      </td>

                      {/* EPS */}
                      <td style={{ ...tdS, color:"#444", fontSize:11 }}>
                        {r.epsLabel}
                      </td>
                    </tr>

                    {isExp && (
                      <tr style={{ background:"#050505" }}>
                        <td colSpan={9} style={{ padding:"12px 16px", fontSize:11,
                          color:"#555", lineHeight:1.75, borderBottom:"1px solid #0d0d0d" }}>
                          {r.note || "Geen notitie"}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


// ── Opportunity Scanner Tab (Rule #1 Edition) ───────────────────────────────
function ScannerTab() {
  const [scans, setScans]         = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [exitSignals, setExitSignals] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [running, setRunning]     = useState(false);
  const [lastRun, setLastRun]     = useState(null);
  const [view, setView]           = useState("koopkansen");

  const load = async () => {
    setLoading(true);
    try {
      const [{ data: sd }, { data: wd }, { data: ed }] = await Promise.all([
        SB.from("opportunity_scans").select("*").order("scanned_at", { ascending: false }).limit(300),
        SB.from("rule1_watchlist").select("*").order("symbol"),
        SB.from("exit_signals").select("*").order("signal_date", { ascending: false }).limit(20),
      ]);
      if (sd?.length) {
        const by = {};
        for (const r of sd) if (!by[r.symbol]) by[r.symbol] = r;
        setScans(Object.values(by).sort((a, b) => b.score - a.score));
        setLastRun(new Date(sd[0].scanned_at));
      }
      if (wd) setWatchlist(wd);
      if (ed) setExitSignals(ed);
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await fetch(
        "https://jnuhyhjwoevoleezshum.supabase.co/functions/v1/opportunity-scanner",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      await r.json();
      await load();
    } catch(e) { console.error(e); }
    setRunning(false);
  };

  useEffect(() => { load(); }, []);

  // Signal type groupings
  const panicDips    = scans.filter(s => (s.signal_type === "panic_dip" || s.signal_type === "both") && s.score >= 30);
  const undervalued  = scans.filter(s => (s.signal_type === "undervalued" || s.signal_type === "both") && s.score >= 30);
  const both         = scans.filter(s => s.signal_type === "both" && s.score >= 30);
  const totalOpps    = [...new Set([...panicDips, ...undervalued].map(s => s.symbol))].length;

  const moatIcon  = t => !t ? "🏰" : t.includes("Toll") ? "🌉" : t.includes("Brand") ? "👑" : t.includes("Switch") ? "🔒" : t.includes("Network") ? "🕸️" : t.includes("Low") ? "💰" : t.includes("Secret") ? "🔬" : "🏰";
  const moatColor = t => !t ? "#444" : t.includes("Toll") ? "#00e5a0" : t.includes("Brand") ? "#f5c842" : t.includes("Switch") ? "#7be0c0" : t.includes("Network") ? "#ff9966" : "#888";
  const scoreColor = s => s >= 70 ? "#00e5a0" : s >= 50 ? "#f5c842" : s >= 30 ? "#888" : "#333";

  // Shared scan card component (inline)
  const ScanCard = ({ scan, highlight }) => {
    const wl = watchlist.find(w => w.symbol === scan.symbol);
    const mosPctNum = scan.mos_pct != null ? Number(scan.mos_pct) : null;
    const price      = scan.price       ? Number(scan.price)       : null;
    const sticker    = scan.sticker_price ? Number(scan.sticker_price) : null;
    const mosPrice   = scan.mos_price   ? Number(scan.mos_price)   : null;

    // Where is current price on the ladder?
    const belowMOS    = price && mosPrice   && price <= mosPrice;
    const belowSticker= price && sticker    && price <= sticker;
    const pctFromMOS  = price && mosPrice   ? ((price - mosPrice) / mosPrice * 100) : null;

    // Price ladder: show 3 zones visually
    const ladderPct = (() => {
      if (!price || !sticker) return null;
      const low  = sticker * 0.4;  // extreme bottom
      const high = sticker * 1.3;  // extended
      return Math.min(96, Math.max(4, ((price - low) / (high - low)) * 100));
    })();
    const mosPct = (() => {
      if (!mosPrice || !sticker) return null;
      const low  = sticker * 0.4;
      const high = sticker * 1.3;
      return Math.min(96, Math.max(4, ((mosPrice - low) / (high - low)) * 100));
    })();

    return (
      <div style={{
        background: "#070707",
        border: `1.5px solid ${highlight ? "#00e5a033" : "#141414"}`,
        borderRadius: 12, padding: "14px 16px",
      }}>
        {/* Top row */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
          <div>
            <span style={{ fontFamily:"monospace", fontWeight:700, fontSize:18, color:"#e0e0e0" }}>{scan.symbol}</span>
            {scan.signal_type === "both" && (
              <span style={{ marginLeft:8, fontSize:10, fontWeight:700, color:"#f5c842",
                background:"#f5c84218", borderRadius:5, padding:"2px 8px" }}>PANIC + VALUE</span>
            )}
            {wl && (
              <span style={{ marginLeft:8, fontSize:11, color:moatColor(wl.moat_type) }}>
                {moatIcon(wl.moat_type)} {wl.moat_type}
              </span>
            )}
            {scan.insider_bought && (
              <span style={{ marginLeft:6, fontSize:10, fontWeight:700, color:"#00e5a0",
                background:"#00e5a018", border:"1px solid #00e5a033", borderRadius:5, padding:"2px 8px" }}>
                🏦 INSIDER KOCHT
              </span>
            )}
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontFamily:"monospace", fontSize:22, fontWeight:700, color:scoreColor(scan.score) }}>{scan.score}</div>
            <div style={{ fontSize:9, color:"#333" }}>/100</div>
          </div>
        </div>

        {/* Moat note */}
        {wl?.moat_note && (
          <div style={{ fontSize:11, color:"#444", marginBottom:10, lineHeight:1.5 }}>{wl.moat_note}</div>
        )}

        {/* ── BUY PRICE LADDER ── */}
        {sticker && mosPrice && price ? (
          <div style={{ background:"#0a0a0a", borderRadius:10, padding:"12px 14px", marginBottom:12, border:"1px solid #1a1a1a" }}>

            {/* Action label */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:11, fontWeight:700,
                color: belowMOS ? "#00e5a0" : belowSticker ? "#f5c842" : "#ff6b6b" }}>
                {belowMOS
                  ? "✅ KOPEN — prijs onder MOS grens"
                  : belowSticker
                  ? "👀 WACHTEN — onder sticker maar boven MOS"
                  : `⏳ NOG NIET — ${pctFromMOS != null ? Math.abs(pctFromMOS).toFixed(0) + "% boven koopgrens" : "boven sticker"}`}
              </div>
              <div style={{ fontSize:10, color:"#333" }}>
                {scan.growth_rate_used ? `${scan.growth_rate_used}% groei · PE ${scan.future_pe_used}×` : ""}
              </div>
            </div>

            {/* Ladder bar */}
            {ladderPct !== null && mosPct !== null && (
              <div style={{ position:"relative", height:28, marginBottom:10 }}>
                {/* Background zones */}
                <div style={{ position:"absolute", left:0, top:8, height:8, width:"100%", borderRadius:4,
                  background:"linear-gradient(to right, #00e5a022, #00e5a022 " + mosPct + "%, #f5c84222 " + mosPct + "%, #f5c84222 65%, #ff6b6b22 65%, #ff6b6b22)" }}/>

                {/* MOS line */}
                <div style={{ position:"absolute", left: mosPct + "%", top:4, width:2, height:16,
                  background:"#00e5a0", borderRadius:1, transform:"translateX(-50%)" }}/>
                <div style={{ position:"absolute", left: mosPct + "%", top:22, fontSize:8,
                  color:"#00e5a0", transform:"translateX(-50%)", whiteSpace:"nowrap" }}>
                  KOOP ${mosPrice.toFixed(0)}
                </div>

                {/* Sticker line */}
                <div style={{ position:"absolute", left:"65%", top:4, width:2, height:16,
                  background:"#f5c842", borderRadius:1 }}/>
                <div style={{ position:"absolute", left:"65%", top:22, fontSize:8,
                  color:"#f5c842", transform:"translateX(-50%)", whiteSpace:"nowrap" }}>
                  FAIR ${sticker.toFixed(0)}
                </div>

                {/* Current price marker */}
                <div style={{ position:"absolute", left: ladderPct + "%", top:2, width:10, height:20,
                  background: belowMOS ? "#00e5a0" : belowSticker ? "#f5c842" : "#ff6b6b",
                  borderRadius:3, transform:"translateX(-50%)", opacity:0.9 }}/>
                <div style={{ position:"absolute", left: ladderPct + "%", top:"-14px", fontSize:9,
                  color: belowMOS ? "#00e5a0" : belowSticker ? "#f5c842" : "#ff6b6b",
                  fontFamily:"monospace", fontWeight:700, transform:"translateX(-50%)", whiteSpace:"nowrap" }}>
                  ${price.toFixed(0)}
                </div>
              </div>
            )}

            {/* Price summary row */}
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:16 }}>
              {[
                { label:"Huidige prijs", value:`$${price.toFixed(0)}`,
                  color: belowMOS ? "#00e5a0" : belowSticker ? "#f5c842" : "#888", bold:true },
                { label:`Koopgrens (MOS)`, value:`$${mosPrice.toFixed(0)}`,
                  color:"#00e5a0", bold:false },
                { label:"Sticker (fair value)", value:`$${sticker.toFixed(0)}`,
                  color:"#f5c842", bold:false },
                { label:"Verschil met koopgrens", value: pctFromMOS != null
                  ? `${pctFromMOS > 0 ? "+" : ""}${pctFromMOS.toFixed(0)}%`
                  : "—",
                  color: pctFromMOS != null && pctFromMOS <= 0 ? "#00e5a0" : pctFromMOS != null && pctFromMOS <= 20 ? "#f5c842" : "#ff6b6b",
                  bold: true },
              ].map(m => (
                <div key={m.label} style={{ flex:"1 1 80px", background:"#0c0c0c", borderRadius:7, padding:"7px 10px" }}>
                  <div style={{ fontSize:9, color:"#333", textTransform:"uppercase", letterSpacing:0.4, marginBottom:3 }}>{m.label}</div>
                  <div style={{ fontFamily:"monospace", fontSize:13, fontWeight: m.bold ? 700 : 500, color:m.color }}>{m.value}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Fallback if no sticker price */
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(100px, 1fr))", gap:8, marginBottom:10 }}>
            {[
              { label:"Prijs", value: price ? `$${price.toFixed(0)}` : "—", color:"#888" },
              { label:"PEG", value: scan.peg ? Number(scan.peg).toFixed(2) : "—",
                color: Number(scan.peg) < 0.75 ? "#00e5a0" : Number(scan.peg) < 1.0 ? "#7be0c0" : "#888" },
              { label:"5-dag", value: scan.price_5d_chg_pct != null
                ? `${Number(scan.price_5d_chg_pct) > 0 ? "+" : ""}${Number(scan.price_5d_chg_pct).toFixed(1)}%` : "—",
                color: Number(scan.price_5d_chg_pct) <= -15 ? "#00e5a0" : "#888" },
            ].map(m => (
              <div key={m.label} style={{ background:"#0c0c0c", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ fontSize:9, color:"#333", textTransform:"uppercase", letterSpacing:0.5, marginBottom:3 }}>{m.label}</div>
                <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:m.color }}>{m.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Secondary metrics row */}
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
          {scan.peg && (
            <div style={{ background:"#0c0c0c", borderRadius:6, padding:"4px 10px", fontSize:11 }}>
              PEG <span style={{ fontFamily:"monospace", fontWeight:700,
                color: Number(scan.peg) < 0.75 ? "#00e5a0" : Number(scan.peg) < 1.0 ? "#7be0c0" : "#888" }}>
                {Number(scan.peg).toFixed(2)}
              </span>
            </div>
          )}
          {scan.price_5d_chg_pct != null && (
            <div style={{ background:"#0c0c0c", borderRadius:6, padding:"4px 10px", fontSize:11 }}>
              5d <span style={{ fontFamily:"monospace", fontWeight:700,
                color: Number(scan.price_5d_chg_pct) <= -15 ? "#00e5a0" : Number(scan.price_5d_chg_pct) < 0 ? "#f5c842" : "#ff6b6b" }}>
                {Number(scan.price_5d_chg_pct) > 0 ? "+" : ""}{Number(scan.price_5d_chg_pct).toFixed(1)}%
              </span>
            </div>
          )}
          {scan.peg_percentile != null && scan.peg_percentile >= 0 && (
            <div style={{ background:"#0c0c0c", borderRadius:6, padding:"4px 10px", fontSize:11 }}>
              PEG percentiel <span style={{ fontFamily:"monospace", fontWeight:700,
                color: scan.peg_percentile <= 10 ? "#00e5a0" : scan.peg_percentile <= 25 ? "#7be0c0" : "#f5c842" }}>
                P{scan.peg_percentile}
              </span>
            </div>
          )}
          {scan.signal_reason?.includes("Earnings over") && (
            <div style={{ fontSize:10, color:"#f5c842", background:"#f5c84214",
              border:"1px solid #f5c84233", borderRadius:5, padding:"4px 10px", fontWeight:700 }}>
              ⚠️ {scan.signal_reason.match(/Earnings over \d+d/)?.[0]}
            </div>
          )}
          {scan.signal_reason?.includes("Post-earnings") && (
            <div style={{ fontSize:10, color:"#00e5a0", background:"#00e5a014", borderRadius:5, padding:"4px 10px" }}>
              ✓ Post-earnings daling
            </div>
          )}
        </div>

        {/* Signal reasons */}
        {scan.signal_reason && scan.signal_reason !== "Geen signaal" && (
          <div style={{ fontSize:11, color:"#555", fontStyle:"italic", lineHeight:1.5 }}>{scan.signal_reason}</div>
        )}
        {scan.insider_note && scan.insider_bought && (
          <div style={{ fontSize:10, color:"#00e5a0", marginTop:6, background:"#00e5a010", borderRadius:5, padding:"4px 8px" }}>
            🏦 {scan.insider_note}
          </div>
        )}
        <div style={{ fontSize:9, color:"#222", marginTop:8 }}>
          {new Date(scan.scanned_at).toLocaleString("nl-NL")}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:10 }}>
          <div>
            <div style={{ fontSize:18, fontWeight:700, color:"#e0e0e0", marginBottom:4 }}>🎯 Rule #1 Scanner</div>
            <div style={{ fontSize:12, color:"#444" }}>
              {watchlist.length} moat stocks · 2 signaaltypen: panic dip + structureel ondergewaardeerd
            </div>
          </div>
          <button onClick={runNow} disabled={running} style={{
            background: running ? "#1a1a1a" : "#00e5a0", border:"none", borderRadius:10,
            color: running ? "#555" : "#000", padding:"10px 18px", fontSize:13, fontWeight:700,
            cursor:"pointer", flexShrink:0, minHeight:44, display:"flex", alignItems:"center", gap:8,
          }}>
            {running ? <><Spinner size={14}/> Scanning…</> : "▶ Scan Nu"}
          </button>
        </div>
        <div style={{ display:"flex", gap:12, flexWrap:"wrap", fontSize:11, color:"#333" }}>
          {lastRun && <span>Laatste: <span style={{ color:"#555" }}>{lastRun.toLocaleString("nl-NL")}</span></span>}
          <span>Automatisch: <span style={{ color:"#555" }}>weekdagen 19:30</span></span>
          {totalOpps > 0 && (
            <span style={{ color:"#00e5a0", fontWeight:700,
              background:"#00e5a018", padding:"2px 10px", borderRadius:5, border:"1px solid #00e5a033" }}>
              🔥 {totalOpps} koopkans{totalOpps > 1 ? "en" : ""}
            </span>
          )}
        </div>
      </div>

      {/* View tabs */}
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        {[
          ["koopkansen", `🔥 Alle kansen (${totalOpps})`],
          ["panic", `📉 Panic Dips (${panicDips.length})`],
          ["value",  `💲 Ondergewaardeerd (${undervalued.length})`],
          ["all",   `📋 Alles (${scans.length})`],
          ["exits",     `📤 Exit Signalen (${exitSignals.length})`],
          ["watchlist", `🏰 Watchlist (${watchlist.length})`],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)} style={{
            padding:"8px 14px", borderRadius:8, border:"1.5px solid",
            borderColor: view === id ? "#00e5a066" : "#222",
            background: view === id ? "#00e5a011" : "#0c0c0c",
            color: view === id ? "#00e5a0" : "#555",
            fontWeight: view === id ? 700 : 500, fontSize:12, cursor:"pointer", minHeight:40,
          }}>{label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ display:"flex", alignItems:"center", gap:10, color:"#333", fontFamily:"monospace", padding:"40px 0" }}>
          <Spinner/> Laden…
        </div>
      ) : (
        <>
          {/* ── ALLE KANSEN ── */}
          {view === "koopkansen" && (
            totalOpps === 0 ? (
              <div style={{ background:"#070707", borderRadius:12, padding:"30px 20px", textAlign:"center" }}>
                <div style={{ fontSize:24, marginBottom:10 }}>✅</div>
                <div style={{ fontSize:14, fontWeight:700, color:"#555", marginBottom:6 }}>Geen koopkansen gevonden</div>
                <div style={{ fontSize:12, color:"#2a2a2a", lineHeight:1.6 }}>
                  Geen van de 70 watchlist stocks staat onder sticker price of heeft een irrationele daling.<br/>
                  Goed teken — wacht op de volgende correctie.
                </div>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {/* Both signal types first */}
                {both.length > 0 && <>
                  <div style={{ fontSize:10, color:"#f5c842", fontWeight:700, textTransform:"uppercase", letterSpacing:1, margin:"4px 0 2px" }}>
                    🔥 Dubbel signaal — panic én ondergewaardeerd
                  </div>
                  {both.map(s => <ScanCard key={s.symbol} scan={s} highlight={true}/>)}
                </>}
                {/* Panic dips */}
                {panicDips.filter(s => s.signal_type !== "both").length > 0 && <>
                  <div style={{ fontSize:10, color:"#ff9966", fontWeight:700, textTransform:"uppercase", letterSpacing:1, margin:"8px 0 2px" }}>
                    📉 Panic Dips — ≥15% daling, PEG &lt;1.0
                  </div>
                  {panicDips.filter(s => s.signal_type !== "both").map(s => <ScanCard key={s.symbol} scan={s} highlight={true}/>)}
                </>}
                {/* Undervalued */}
                {undervalued.filter(s => s.signal_type !== "both").length > 0 && <>
                  <div style={{ fontSize:10, color:"#7be0c0", fontWeight:700, textTransform:"uppercase", letterSpacing:1, margin:"8px 0 2px" }}>
                    💲 Structureel Ondergewaardeerd — onder sticker price (30% MOS)
                  </div>
                  {undervalued.filter(s => s.signal_type !== "both").map(s => <ScanCard key={s.symbol} scan={s} highlight={true}/>)}
                </>}
              </div>
            )
          )}

          {/* ── PANIC DIPS ── */}
          {view === "panic" && (
            <>
              <div style={{ background:"#0c0c0c", borderRadius:10, padding:"12px 14px", marginBottom:14, border:"1px solid #1a1a1a" }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#ff9966", marginBottom:6 }}>📉 Panic Dip Logica</div>
                <div style={{ fontSize:11, color:"#2a2a2a", lineHeight:1.7 }}>
                  Stock daalt ≥15% in 5 dagen terwijl de business intact is. PEG onder 1.0 bevestigt dat de prijs
                  niet de groei rechtvaardigt. Excess decline vs S&P toont irrationele verkoop. CrowdStrike-scenario.
                </div>
              </div>
              {panicDips.length === 0
                ? <div style={{ color:"#2a2a2a", textAlign:"center", padding:"40px 0", fontFamily:"monospace" }}>Geen panic dips — markt is kalm</div>
                : <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {panicDips.map(s => <ScanCard key={s.symbol} scan={s} highlight={true}/>)}
                  </div>
              }
            </>
          )}

          {/* ── STRUCTUREEL ONDERGEWAARDEERD ── */}
          {view === "value" && (
            <>
              <div style={{ background:"#0c0c0c", borderRadius:10, padding:"12px 14px", marginBottom:14, border:"1px solid #1a1a1a" }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#7be0c0", marginBottom:6 }}>💲 Phil Town Sticker Price Methode</div>
                <div style={{ fontSize:11, color:"#2a2a2a", lineHeight:1.7 }}>
                  <strong style={{ color:"#444" }}>Sticker price</strong> = toekomstige EPS (10jr) × toekomstige PE, teruggerekend met 15% discount rate per jaar.<br/>
                  <strong style={{ color:"#444" }}>MOS prijs</strong> = sticker price × 70% (30% marge van veiligheid).<br/>
                  Als de huidige prijs onder de MOS prijs zit, koopt Town. Negatieve "Korting" = prijs zit onder MOS.
                </div>
              </div>
              {undervalued.length === 0
                ? <div style={{ color:"#2a2a2a", textAlign:"center", padding:"40px 0", fontFamily:"monospace" }}>Geen stocks onder sticker price (30% MOS)</div>
                : <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {undervalued.map(s => <ScanCard key={s.symbol} scan={s} highlight={true}/>)}
                  </div>
              }
            </>
          )}

          {/* ── ALLE SCANS ── */}
          {view === "all" && (
            scans.length === 0
              ? <div style={{ color:"#2a2a2a", textAlign:"center", padding:"40px 0", fontFamily:"monospace" }}>Nog geen scans. Klik Scan Nu.</div>
              : <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {scans.map(scan => {
                    const wl = watchlist.find(w => w.symbol === scan.symbol);
                    const mosPct = scan.mos_pct != null ? Number(scan.mos_pct) : null;
                    return (
                      <div key={scan.symbol} style={{
                        background:"#070707",
                        border:`1px solid ${scan.signal_type !== "none" ? "#00e5a022" : "#141414"}`,
                        borderRadius:10, padding:"10px 14px",
                        display:"flex", alignItems:"center", gap:10, flexWrap:"wrap",
                      }}>
                        <span style={{ fontFamily:"monospace", fontWeight:700, fontSize:15, color:"#e0e0e0", minWidth:52 }}>{scan.symbol}</span>
                        {wl && <span style={{ fontSize:10, color:moatColor(wl.moat_type) }}>{moatIcon(wl.moat_type)}</span>}
                        <div style={{ fontFamily:"monospace", fontSize:16, fontWeight:700, color:scoreColor(scan.score), marginLeft:"auto" }}>
                          {scan.score}<span style={{ fontSize:9, color:"#333" }}>/100</span>
                        </div>
                        {scan.sticker_price && (
                          <div style={{ fontSize:11, color:"#444" }}>
                            Sticker <span style={{ fontFamily:"monospace", color: scan.price < scan.sticker_price ? "#00e5a0" : "#888" }}>
                              ${Number(scan.sticker_price).toFixed(0)}
                            </span>
                          </div>
                        )}
                        {mosPct != null && (
                          <div style={{ fontFamily:"monospace", fontSize:12,
                            color: mosPct <= -20 ? "#00e5a0" : mosPct <= 0 ? "#7be0c0" : "#555" }}>
                            {mosPct > 0 ? "+" : ""}{mosPct.toFixed(0)}% vs MOS
                          </div>
                        )}
                        <div style={{ fontFamily:"monospace", fontSize:12,
                          color: Number(scan.price_5d_chg_pct) <= -15 ? "#00e5a0" : Number(scan.price_5d_chg_pct) < 0 ? "#f5c842" : "#555" }}>
                          {Number(scan.price_5d_chg_pct) > 0 ? "+" : ""}{Number(scan.price_5d_chg_pct)?.toFixed(1)}% 5d
                        </div>
                        {scan.signal_type !== "none" && (
                          <span style={{ fontSize:9, color:"#00e5a0", fontWeight:700 }}>
                            {scan.signal_type === "both" ? "🔥" : scan.signal_type === "panic_dip" ? "📉" : "💲"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
          )}

          {/* ── EXIT SIGNALEN ── */}
          {view === "exits" && (
            <div>
              <div style={{ background:"#0c0c0c", borderRadius:10, padding:"12px 14px", marginBottom:14, border:"1px solid #1a1a1a" }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#ff9966", marginBottom:6 }}>📤 Exit Signaal Logica — Phil Town</div>
                <div style={{ fontSize:11, color:"#2a2a2a", lineHeight:1.7 }}>
                  Town verkoopt als de prijs de <strong style={{ color:"#444" }}>sticker price bereikt</strong> — het moment
                  dat de markt zijn fair value erkent. Boven sticker price betaal je voor toekomstige groei die
                  nog bewezen moet worden. Een exit signaal verschijnt als de prijs ≥20% boven sticker price staat.
                  Nabij sticker (&lt;20% erboven) is een waarschuwing om je positie te heroverwegen.
                </div>
              </div>
              {exitSignals.length === 0 ? (
                <div style={{ color:"#2a2a2a", textAlign:"center", padding:"30px 0", fontFamily:"monospace", fontSize:12 }}>
                  Geen exit signalen — alle portfolio stocks handelen onder sticker price.
                </div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {exitSignals.map(ex => {
                    const pctAbove = Number(ex.pct_above_sticker);
                    const isStrong = pctAbove >= 20;
                    return (
                      <div key={ex.symbol + ex.signal_date} style={{
                        background:"#070707",
                        border:`1.5px solid ${isStrong ? "#ff966633" : "#f5c84222"}`,
                        borderRadius:12, padding:"14px 16px",
                      }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                            <span style={{ fontFamily:"monospace", fontWeight:700, fontSize:18, color:"#e0e0e0" }}>{ex.symbol}</span>
                            <span style={{ fontSize:11, fontWeight:700,
                              color: isStrong ? "#ff6b6b" : "#f5c842",
                              background: isStrong ? "#ff6b6b18" : "#f5c84218",
                              borderRadius:5, padding:"2px 8px" }}>
                              {isStrong ? "🔴 VERKOOP" : "🟡 OVERWEEG VERKOOP"}
                            </span>
                          </div>
                          <div style={{ textAlign:"right" }}>
                            <div style={{ fontFamily:"monospace", fontSize:20, fontWeight:700,
                              color: isStrong ? "#ff6b6b" : "#f5c842" }}>
                              +{pctAbove.toFixed(0)}%
                            </div>
                            <div style={{ fontSize:9, color:"#333" }}>boven sticker</div>
                          </div>
                        </div>
                        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(120px, 1fr))", gap:8, marginBottom:10 }}>
                          {[
                            { label:"Huidige prijs",  value:`$${Number(ex.price).toFixed(0)}`, color:"#e0e0e0" },
                            { label:"Sticker Price",  value:`$${Number(ex.sticker_price).toFixed(0)}`, color:"#f5c842" },
                            { label:"Boven sticker",  value:`+${pctAbove.toFixed(0)}%`, color: isStrong ? "#ff6b6b" : "#f5c842" },
                            { label:"Datum",          value:new Date(ex.signal_date).toLocaleDateString("nl-NL"), color:"#444" },
                          ].map(m => (
                            <div key={m.label} style={{ background:"#0c0c0c", borderRadius:8, padding:"8px 10px" }}>
                              <div style={{ fontSize:9, color:"#333", textTransform:"uppercase", letterSpacing:0.5, marginBottom:3 }}>{m.label}</div>
                              <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:m.color }}>{m.value}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize:11, color:"#555", fontStyle:"italic" }}>{ex.signal_reason}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── WATCHLIST ── */}
          {view === "watchlist" && (
            <div>
              <div style={{ fontSize:11, color:"#333", marginBottom:12, lineHeight:1.6 }}>
                🌉 Toll Bridge · 👑 Brand · 🔒 Switching · 🕸️ Network · 💰 Low Cost · 🔬 Secret
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(270px, 1fr))", gap:8 }}>
                {watchlist.map(item => (
                  <div key={item.symbol} style={{ background:"#070707", border:"1px solid #141414", borderRadius:10, padding:"12px 14px" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                      <span style={{ fontFamily:"monospace", fontWeight:700, fontSize:14, color:"#e0e0e0" }}>{item.symbol}</span>
                      <span style={{ fontSize:11, color:moatColor(item.moat_type) }}>{moatIcon(item.moat_type)} {item.moat_type}</span>
                    </div>
                    <div style={{ fontSize:11, color:"#2a2a2a", lineHeight:1.5 }}>{item.moat_note}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
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
  const [marketFearGreed, setMarketFearGreed] = useState(null);

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
      // Fetch Fear & Greed for portfolio context
      try {
        const r = await fetch("/api/market");
        const d = await r.json();
        if (d.fearGreed?.score != null) setMarketFearGreed(d.fearGreed.score);
      } catch(e) { /* silent */ }
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
    { id: "markt",     label: "Market",     icon: "chart" },
    { id: "shortlist", label: `Shortlist${shortlist.length ? ` (${shortlist.length})` : ""}`, icon: "star" },
    { id: "portfolio", label: "Portfolio",  icon: "briefcase" },
    { id: "valuation", label: "Valuation",  icon: "chart" },
    { id: "intel",     label: "⚡ Edge Intel", icon: "chart" },
    { id: "peg",       label: "PEG Chart",  icon: "chart" },
    { id: "scanner",   label: "🎯 Scanner",  icon: "chart" },
    { id: "tracker",   label: "📊 Tracker",   icon: "chart" },
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

        /* ── App shell ── */
        .app-header {
          border-bottom: 1px solid #0e0e0e;
          padding: 0 20px;
          display: flex;
          align-items: center;
          gap: 12px;
          background: #060606;
          position: sticky;
          top: 0;
          z-index: 10;
          overflow: hidden;
        }
        .app-logo {
          padding: 14px 0;
          display: flex;
          align-items: baseline;
          gap: 5px;
          flex-shrink: 0;
        }
        .app-tabs {
          display: flex;
          gap: 0;
          overflow-x: auto;
          flex: 1;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          min-width: 0;
        }
        .app-tabs::-webkit-scrollbar { display: none; }
        .app-tab-btn {
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: #3a3a3a;
          padding: 15px 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 13px;
          font-weight: 400;
          white-space: nowrap;
          transition: color 0.15s;
          flex-shrink: 0;
          min-height: 50px;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .app-tab-btn.active { border-bottom-color: #00e5a0; color: #e0e0e0; font-weight: 600; }
        .app-tab-btn:active { color: #aaa; }
        .app-meta { display: flex; align-items: center; gap: 5px; font-size: 10px; color: #1e1e1e; font-family: monospace; flex-shrink: 0; }
        .app-content { padding: 20px 20px; max-width: 1400px; margin: 0 auto; }

        /* ── Cards grid ── */
        .cards-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
        .stat-card { background: #070707; border: 1px solid #141414; border-radius: 10px; padding: 14px; }
        .stat-card-label { font-size: 9px; color: #333; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
        .stat-card-value { font-family: monospace; font-size: 16px; font-weight: 700; }

        /* ── Edge Intel — mobile-first ── */
        .ei-nav { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; -webkit-overflow-scrolling:touch; scrollbar-width:none; margin-bottom:16px; }
        .ei-nav::-webkit-scrollbar { display:none; }
        .ei-nav-btn { flex-shrink:0; padding:10px 18px; border-radius:10px; border:1.5px solid #222; background:#0c0c0c; color:#555; font-weight:500; font-size:13px; cursor:pointer; white-space:nowrap; min-height:44px; touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
        .ei-nav-btn.active { border-color:#00e5a066; background:#00e5a012; color:#00e5a0; font-weight:700; }
        /* Form container */
        .ei-form { background:#0c0c0c; border:1.5px solid #1e1e1e; border-radius:14px; padding:16px; margin-bottom:12px; }
        .ei-form.accent-green { border-color:#00e5a022; }
        .ei-form-title { font-size:11px; font-weight:700; color:#444; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:14px; }
        .ei-form-title.green { color:#00e5a0; }
        /* Grid — single column on mobile, expands on desktop */
        .ei-row { display:grid; grid-template-columns:1fr; gap:10px; margin-bottom:10px; }
        @media(min-width:520px){ .ei-row { grid-template-columns:1fr 1fr; } }
        @media(min-width:800px){ .ei-row { grid-template-columns:1fr 1fr 1fr; } }
        .ei-row.cols2 { grid-template-columns:1fr 1fr; }
        .ei-span { grid-column:1 / -1; }
        /* Field */
        .ei-field { display:flex; flex-direction:column; gap:6px; }
        .ei-label { font-size:11px; font-weight:600; color:#666; text-transform:uppercase; letter-spacing:0.7px; }
        .ei-hint { font-size:10px; color:#2a2a2a; }
        .ei-field input, .ei-field select {
          width:100%; background:#141414; border:1.5px solid #252525; border-radius:10px;
          color:#e0e0e0; padding:13px 14px; font-size:16px; min-height:50px;
          box-sizing:border-box; -webkit-appearance:none; appearance:none;
          touch-action:manipulation; font-family:inherit;
        }
        .ei-field input:focus, .ei-field select:focus { border-color:#00e5a055; outline:none; background:#181818; }
        .ei-field select {
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M0 0l6 8 6-8z' fill='%23666'/%3E%3C/svg%3E");
          background-repeat:no-repeat; background-position:right 14px center; padding-right:36px; cursor:pointer;
        }
        .ei-display { background:#00e5a00a; border:1.5px solid #00e5a022; border-radius:10px; padding:13px 14px; min-height:50px; display:flex; align-items:center; font-family:monospace; font-size:20px; font-weight:700; color:#00e5a0; }
        /* Save button */
        .ei-save { width:100%; background:#00e5a0; border:none; border-radius:12px; color:#000; padding:15px; font-size:16px; font-weight:700; cursor:pointer; min-height:52px; margin-top:4px; touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
        .ei-save:disabled { background:#1a1a1a; color:#444; }
        .ei-save:active { opacity:0.85; }
        /* Data section */
        .ei-section { display:flex; flex-direction:column; gap:10px; }
        .ei-period-block { background:#111; border:1.5px solid #1e1e1e; border-radius:12px; padding:14px; }
        .ei-period-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
        .ei-period-lbl { font-family:monospace; font-size:12px; font-weight:700; color:#444; }
        .ei-period-total { font-family:monospace; font-size:13px; font-weight:700; color:#00e5a0; }
        .ei-card-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
        @media(min-width:520px){ .ei-card-grid { grid-template-columns:repeat(3,1fr); } }
        @media(min-width:800px){ .ei-card-grid { grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); } }
        .ei-card { background:#0c0c0c; border-radius:10px; padding:12px; border:1px solid #1a1a1a; }
        .ei-card-lbl { font-size:9px; color:#333; text-transform:uppercase; letter-spacing:0.8px; margin-bottom:5px; }
        .ei-card-val { font-family:monospace; font-size:16px; font-weight:700; }
        .ei-card-sub { font-size:9px; color:#2a2a2a; margin-top:3px; }
        /* Record actions */
        .ei-actions { display:flex; gap:8px; padding-top:10px; border-top:1px solid #1a1a1a; margin-top:10px; }
        .ei-btn-edit { flex:1; padding:11px 0; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; border:1.5px solid #252525; background:#141414; color:#888; min-height:44px; touch-action:manipulation; }
        .ei-btn-del { flex:1; padding:11px 0; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; border:1.5px solid #ff6b6b22; background:#ff6b6b08; color:#ff6b6b; min-height:44px; touch-action:manipulation; }
        /* Signal cards */
        .ei-signal { border-radius:12px; padding:14px; border:1.5px solid #1e1e1e; }
        .ei-signal-hdr { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
        .ei-signal-badge { display:inline-block; font-size:11px; font-weight:700; border-radius:6px; padding:3px 10px; text-transform:uppercase; margin-left:10px; vertical-align:middle; }
        .ei-signal-stats { display:flex; gap:20px; flex-wrap:wrap; margin-bottom:8px; }
        .ei-empty { color:#2a2a2a; font-family:monospace; text-align:center; padding:40px 0; font-size:13px; }

        /* ── Valuation assumption inputs ── */
        .val-input {
          width: 100%;
          background: transparent;
          border: none;
          color: #f5c842;
          font-family: monospace;
          font-size: 14px;
          outline: none;
        }

        /* ── Responsive breakpoints ── */
        @media (max-width: 480px) {
          .app-meta { display: none; }
          .app-content { padding: 14px 14px; }
          .cards-grid { grid-template-columns: 1fr 1fr; }
          .ei-field { flex: 1 1 calc(50% - 5px); }
          .ei-field.wide { flex: 1 1 100%; }
          .ei-field.full { flex: 1 1 100%; }
        }
        @media (min-width: 481px) and (max-width: 768px) {
          .app-content { padding: 18px 18px; }
          .cards-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
        }
      `}</style>

      {/* Header */}
      <div className="app-header">
        <div className="app-logo">
          <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>ALPHA</span>
          <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: "#00e5a0" }}>DESK</span>
        </div>
        <div className="app-tabs">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={"app-tab-btn" + (tab === t.id ? " active" : "")}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="app-meta">
          <Icon name="db" size={10}/> SB
        </div>
      </div>

      {/* Content */}
      <div className="app-content">
        {booting ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#2a2a2a", fontFamily: "monospace", padding: "60px 0" }}>
            <Spinner size={18}/> Connecting to database…
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <h1 style={{ fontSize: 18, fontWeight: 700, color: "#e0e0e0", letterSpacing: -0.3 }}>
                {tab === "markt" && "Market Dashboard"}
                {tab === "shortlist" && "Entry Timing Dashboard"}
                {tab === "portfolio" && "Portfolio"}
                {tab === "valuation" && "Valuation"}
                {tab === "intel" && "⚡ Edge Intel"}
                {tab === "peg" && "PEG History"}
              </h1>
              <p style={{ color: "#2a2a2a", fontSize: 12, marginTop: 3 }}>
                {tab === "markt" && "Rational macro context · VIX · Fear & Greed · Yields · Sentiment"}
                {tab === "shortlist" && "52-week position · analyst targets · entry signal per stock"}
                {tab === "portfolio" && "Live P&L · positions synced with Supabase"}
                {tab === "valuation" && "Fair value bands · price vs projected EPS × PE multiple"}
                {tab === "intel" && "Semicon market intel · ASML tool plan · capex by company · growth signals"}
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
              <PortfolioTab positions={positions} setPositions={setPositions} fearGreed={marketFearGreed}/>
            </div>
            <div style={{ display: tab === "valuation" ? "block" : "none" }}>
              <ValuationTab positions={positions} shortlist={shortlist}/>
            </div>
            <div style={{ display: tab === "intel" ? "block" : "none" }}>
              <EdgeIntelTab/>
            </div>
            <div style={{ display: tab === "scanner" ? "block" : "none" }}>
              <ScannerTab/>
            </div>
            <div style={{ display: tab === "tracker" ? "block" : "none" }}>
              <ValuationTrackerTab/>
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
