import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend
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

  // ── PEG: verfijnde multi-source berekening ───────────────────────────────
  const trailingEps = ks.trailingEps?.raw || null;
  const forwardEps = ks.forwardEps?.raw || null;
  const forwardPE = sd.forwardPE?.raw || ks.forwardPE?.raw || null;
  const trailingPE = sd.trailingPE?.raw || ks.trailingPE?.raw || null;

  // Forward EPS groei (1 jaar)
  const forwardGrowth = trailingEps && forwardEps && trailingEps > 0
    ? (forwardEps - trailingEps) / Math.abs(trailingEps)
    : null;

  // TTM earnings growth (YoY actuals)
  const ttmGrowth = fd.earningsGrowth?.raw || null;
  const qtrGrowth = ks.earningsQuarterlyGrowth?.raw || null;
  const revGrowth = fd.revenueGrowth?.raw || null;

  // Kies beste groeivoet — cap extreme cyclical pieken
  let epsGrowthRaw, pegSource, growthUsed;

  if (forwardGrowth !== null && forwardGrowth > 0 && forwardGrowth <= 1.0) {
    epsGrowthRaw = forwardGrowth;
    pegSource = "fwd";
    growthUsed = "1yr forward";
  } else if (ttmGrowth !== null && ttmGrowth > 0 && ttmGrowth <= 2.0) {
    epsGrowthRaw = ttmGrowth;
    pegSource = "ttm";
    growthUsed = "TTM actuals";
  } else if (forwardGrowth !== null && forwardGrowth > 1.0) {
    // Cyclical piek: √(forward) normaliseert de éénjarige explosie
    epsGrowthRaw = Math.sqrt(forwardGrowth);
    pegSource = "fwd↓";
    growthUsed = "forward (normalized)";
  } else if (qtrGrowth !== null && qtrGrowth > 0) {
    epsGrowthRaw = Math.min(qtrGrowth, 2.0);
    pegSource = "qtr";
    growthUsed = "quarterly";
  } else {
    epsGrowthRaw = revGrowth || 0;
    pegSource = "rev";
    growthUsed = "revenue (fallback)";
  }

  const epsGrowthPct = epsGrowthRaw * 100;

  // Gebruik forward P/E als trailing P/E ontbreekt of >150 (distorted door laag basisjaar)
  // Voor cyclicals: forward P/E is eerlijker dan trailing
  const effectivePE = (trailingPE && trailingPE > 0 && trailingPE < 150) ? trailingPE : forwardPE;
  const pegPE = (trailingPE && trailingPE > 0 && trailingPE < 150) ? trailingPE : forwardPE;
  const peg = pegPE && epsGrowthPct > 0 ? pegPE / epsGrowthPct : null;

  // ── Winstgevendheid & cashflow ────────────────────────────────────────────
  const grossMargin = (fd.grossMargins?.raw || 0) * 100;
  const operatingMargin = (fd.operatingMargins?.raw || 0) * 100;
  const roic = (fd.returnOnEquity?.raw || 0) * 100; // ROE als ROIC proxy

  // FCF Margin = Free Cash Flow / Revenue
  const fcf = fd.freeCashflow?.raw || null;
  const revenue = fd.totalRevenue?.raw || null;
  const fcfMargin = fcf && revenue ? (fcf / revenue) * 100 : null;

  // FCF Yield = FCF per share / prijs
  const sharesOut = ks.sharesOutstanding?.raw || null;
  const fcfPerShare = fcf && sharesOut ? fcf / sharesOut : null;
  const fcfYield = fcfPerShare && price ? (fcfPerShare / price) * 100 : null;

  // ── Balans ────────────────────────────────────────────────────────────────
  const totalDebt = fd.totalDebt?.raw || 0;
  const totalCash = fd.totalCash?.raw || 0;
  const ebitda = fd.ebitda?.raw || 0;
  const netDebt = totalDebt - totalCash;
  const netDebtEbitda = ebitda > 0 ? netDebt / ebitda : null;

  // EV/EBITDA
  const enterpriseValue = ks.enterpriseValue?.raw || null;
  const evEbitda = enterpriseValue && ebitda > 0 ? enterpriseValue / ebitda : null;

  // Short Interest %
  const shortPct = ks.shortPercentOfFloat?.raw != null ? ks.shortPercentOfFloat.raw * 100 : null;

  // ── Groei ─────────────────────────────────────────────────────────────────
  const revenueGrowth = (fd.revenueGrowth?.raw || 0) * 100;
  const marketCap = sd.marketCap?.raw || null;

  return {
    symbol: symbol.toUpperCase(),
    name: ap.longName || ap.shortName || symbol,
    price,
    change,
    // Waardering
    pe: effectivePE,
    forwardPE,
    peg,
    pegSource,
    evEbitda,
    // Groei
    epsGrowth: epsGrowthPct,
    revenueGrowth,
    // Winstgevendheid
    grossMargin,
    operatingMargin,
    roic,
    fcfMargin,
    fcfYield,
    // Balans
    netDebtEbitda,
    // Risico
    shortPct,
    // Meta
    marketCap,
    sector: ap.sector || "—",
    logo: `https://logo.clearbit.com/${ap.website?.replace(/https?:\/\//, "").split("/")[0]}`,
    currentEpsGrowth: epsGrowthRaw,
  };
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
    return (data || []).map(r => ({ symbol: r.symbol, shares: r.shares, avgCost: r.avg_cost, thesis: r.thesis }));
  },
  async upsertPortfolio(pos) {
    await SB.from("portfolio").upsert({
      symbol: pos.symbol, shares: pos.shares,
      avg_cost: pos.avgCost, thesis: pos.thesis || ""
    }, { onConflict: "symbol" });
  },
  async deletePortfolio(symbol) { await SB.from("portfolio").delete().eq("symbol", symbol); },

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
const PEGBar = ({ peg }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <div style={{ flex: 1, height: 3, background: "#1a1a1a", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${(Math.min(Math.max(peg || 0, 0), 3) / 3) * 100}%`, height: "100%", background: pegColor(peg), borderRadius: 2, transition: "width 0.5s ease" }}/>
    </div>
    <span style={{ color: pegColor(peg), fontWeight: 700, fontSize: 13, minWidth: 36, textAlign: "right", fontFamily: "monospace" }}>{fmt.num(peg)}</span>
  </div>
);

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
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const out = {};
    for (const item of shortlist) {
      const d = await fetchFull(item.symbol);
      if (d) {
        // Get 52-week data via Yahoo quote
        const qd = await yahooQuote(item.symbol);
        const meta = qd?.chart?.result?.[0]?.meta;
        out[item.symbol] = {
          ...d,
          week52High: meta?.fiftyTwoWeekHigh || null,
          week52Low: meta?.fiftyTwoWeekLow || null,
          analystTarget: null, // comes from quoteSummary financialData.targetMeanPrice
        };
        // Get analyst target from summary
        const sd = await yahooSummary(item.symbol);
        const fin = sd?.quoteSummary?.result?.[0]?.financialData;
        out[item.symbol].analystTarget = fin?.targetMeanPrice?.raw || null;
        out[item.symbol].analystHigh = fin?.targetHighPrice?.raw || null;
        out[item.symbol].analystLow = fin?.targetLowPrice?.raw || null;
        out[item.symbol].numAnalysts = fin?.numberOfAnalystOpinions?.raw || null;
        out[item.symbol].recommendation = fin?.recommendationKey || null;
        if (d.peg) db.savePegSnapshot(item.symbol, d.peg, d.pe, d.price, d.epsGrowth).catch(() => {});
      }
    }
    setStocks(out);
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

  // Entry score: 0-100 based on 52w position, analyst upside, PEG
  const calcScore = (s, item) => {
    if (!s) return null;
    let score = 50;
    // 52-week position: low = buying opportunity
    if (s.week52High && s.week52Low) {
      const range = s.week52High - s.week52Low;
      const pos = range > 0 ? (s.price - s.week52Low) / range : 0.5;
      score -= (pos - 0.5) * 40; // onderin range = +20pts, bovenkant = -20pts
    }
    // Analyst upside
    if (s.analystTarget && s.price) {
      const upside = (s.analystTarget - s.price) / s.price;
      score += Math.min(upside * 100, 30); // max +30pts bij hoog upside
    }
    // PEG
    if (s.peg) {
      if (s.peg < 0.8) score += 15;
      else if (s.peg < 1.5) score += 5;
      else score -= 10;
    }
    // Entry target bereikt
    if (item.target && s.price <= item.target) score += 20;
    return Math.max(0, Math.min(100, Math.round(score)));
  };

  const scoreLabel = (score) => {
    if (score === null) return ["—", "#444"];
    if (score >= 70) return ["BUY ZONE", "#00e5a0"];
    if (score >= 50) return ["FAIR", "#f5c842"];
    return ["EXPENSIVE", "#ff6b6b"];
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <span style={{ color: "#444", fontSize: 12, fontFamily: "monospace" }}>{shortlist.length} positions · entry timing dashboard</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refresh} disabled={refreshing} style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: refreshing ? "#2a2a2a" : "#555", padding: "7px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {refreshing ? <Spinner/> : <Icon name="refresh" size={13}/>} Refresh
          </button>
          <button onClick={() => setAdding(true)} style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
            <Icon name="plus" size={13}/> Add
          </button>
        </div>
      </div>

      {adding && (
        <div style={{ background: "#070707", border: "1px solid #1e1e1e", borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            {[["Symbol", "symbol", 85], ["Entry $", "target", 95], ["Thesis", "thesis", 290]].map(([label, key, w]) => (
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

      {shortlist.length === 0 && !adding && (
        <div style={{ textAlign: "center", padding: 60, color: "#222", fontFamily: "monospace" }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>★</div>
          <div>Shortlist empty — add stocks via the Scanner</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 12 }}>
        {shortlist.map(item => {
          const s = stocks[item.symbol];
          const score = calcScore(s, item);
          const [signalLabel, signalColor] = scoreLabel(score);
          const week52Pct = s?.week52High && s?.week52Low
            ? ((s.price - s.week52Low) / (s.week52High - s.week52Low)) * 100
            : null;
          const analystUpside = s?.analystTarget && s?.price
            ? ((s.analystTarget - s.price) / s.price) * 100
            : null;
          const atTarget = s && item.target && s.price <= item.target;

          return (
            <div key={item.symbol} style={{ background: "#070707", border: `1px solid ${atTarget ? "#00e5a033" : score >= 70 ? "#00e5a018" : "#141414"}`, borderRadius: 14, padding: "18px 20px", position: "relative" }}>

              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {s?.logo && <img src={s.logo} alt="" style={{ width: 32, height: 32, borderRadius: 8, objectFit: "contain", background: "#111", padding: 3 }} onError={e => e.target.style.display="none"}/>}
                  <div>
                    <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#fff" }}>{item.symbol}</div>
                    <div style={{ fontSize: 11, color: "#555", marginTop: 1, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s?.name || "—"}</div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  {/* Instap signaal */}
                  <div style={{ background: signalColor + "22", border: `1px solid ${signalColor}44`, borderRadius: 6, padding: "3px 10px", fontSize: 11, fontWeight: 700, color: signalColor, fontFamily: "monospace" }}>
                    {score !== null ? `${score} — ${signalLabel}` : "loading…"}
                  </div>
                  <select value={item.status} onChange={e => updateStatus(item.symbol, e.target.value)}
                    style={{ background: "#0d0d0d", border: `1px solid ${statusColor[item.status]}33`, borderRadius: 5, color: statusColor[item.status], padding: "3px 8px", fontSize: 11, fontFamily: "monospace", cursor: "pointer" }}>
                    {STATUSES.map(st => <option key={st}>{st}</option>)}
                  </select>
                </div>
              </div>

              {/* Prijs + change */}
              <div style={{ display: "flex", gap: 16, alignItems: "baseline", marginBottom: 14 }}>
                <span style={{ fontFamily: "monospace", fontSize: 22, fontWeight: 700, color: "#e0e0e0" }}>{s ? fmt.price(s.price) : <Spinner/>}</span>
                {s && <span style={{ fontFamily: "monospace", fontSize: 13, color: s.change >= 0 ? "#00e5a0" : "#ff6b6b", fontWeight: 600 }}>{fmt.pct(s.change)} today</span>}
              </div>

              {/* 52-week balk */}
              {week52Pct !== null && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "#333", fontFamily: "monospace" }}>52W LOW {fmt.price(s.week52Low)}</span>
                    <span style={{ fontSize: 10, color: "#555", fontFamily: "monospace" }}>position {week52Pct.toFixed(0)}%</span>
                    <span style={{ fontSize: 10, color: "#333", fontFamily: "monospace" }}>52W HIGH {fmt.price(s.week52High)}</span>
                  </div>
                  <div style={{ height: 6, background: "#111", borderRadius: 3, position: "relative", overflow: "visible" }}>
                    <div style={{ position: "absolute", left: 0, top: 0, width: `${week52Pct}%`, height: "100%", background: week52Pct < 30 ? "#00e5a0" : week52Pct < 70 ? "#f5c842" : "#ff6b6b", borderRadius: 3 }}/>
                    <div style={{ position: "absolute", left: `${week52Pct}%`, top: -3, width: 2, height: 12, background: "#fff", borderRadius: 1, transform: "translateX(-50%)" }}/>
                    {item.target && s && (
                      <div style={{ position: "absolute", left: `${Math.max(0, Math.min(100, ((item.target - s.week52Low) / (s.week52High - s.week52Low)) * 100))}%`, top: -5, fontSize: 9, color: "#f5c842", transform: "translateX(-50%)", whiteSpace: "nowrap", fontFamily: "monospace" }}>▼ target</div>
                    )}
                  </div>
                </div>
              )}

              {/* Key metrics grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                {[
                  ["PEG", fmt.num(s?.peg), pegColor(s?.peg)],
                  ["fwd P/E", fmt.num(s?.forwardPE), s?.forwardPE < 25 ? "#00e5a0" : s?.forwardPE < 40 ? "#f5c842" : "#ff6b6b"],
                  ["EPS Grw", fmt.pct(s?.epsGrowth), "#888"],
                  ["Gross Mgn", fmt.pct(s?.grossMargin), "#888"],
                ].map(([label, val, color]) => (
                  <div key={label} style={{ background: "#0a0a0a", borderRadius: 7, padding: "8px 10px" }}>
                    <div style={{ fontSize: 9, color: "#333", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600, color }}>{val}</div>
                  </div>
                ))}
              </div>

              {/* Analyst consensus */}
              {s?.analystTarget && (
                <div style={{ background: "#0a0a0a", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: 1 }}>Analyst consensus · {s.numAnalysts} analysts</span>
                    {s.recommendation && (
                      <span style={{ fontSize: 10, color: recColor[s.recommendation] || "#888", fontWeight: 700, textTransform: "uppercase" }}>{s.recommendation?.replace("_", " ")}</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "#444", fontFamily: "monospace" }}>{fmt.price(s.analystLow)}</span>
                    <div style={{ flex: 1, height: 4, background: "#1a1a1a", borderRadius: 2, position: "relative" }}>
                      {/* Range bar */}
                      {s.analystLow && s.analystHigh && (
                        <div style={{
                          position: "absolute",
                          left: `${Math.max(0, ((s.analystLow - s.price * 0.7) / (s.price * 0.6)) * 100)}%`,
                          width: "60%",
                          height: "100%",
                          background: "#00e5a033",
                          borderRadius: 2
                        }}/>
                      )}
                      {/* Current price marker */}
                      <div style={{ position: "absolute", left: "30%", top: -4, width: 2, height: 12, background: "#555", borderRadius: 1 }}/>
                      {/* Target marker */}
                      {s.analystTarget && s.analystLow && s.analystHigh && (
                        <div style={{
                          position: "absolute",
                          left: `${Math.min(95, Math.max(5, 30 + (((s.analystTarget - s.price) / (s.analystHigh - s.analystLow)) * 60)))}%`,
                          top: -4, width: 2, height: 12, background: "#00e5a0", borderRadius: 1
                        }}/>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: "#444", fontFamily: "monospace" }}>{fmt.price(s.analystHigh)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", marginTop: 6, gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "#888", fontFamily: "monospace" }}>Target: {fmt.price(s.analystTarget)}</span>
                    <span style={{ fontSize: 12, color: analystUpside >= 0 ? "#00e5a0" : "#ff6b6b", fontWeight: 700, fontFamily: "monospace" }}>
                      {analystUpside !== null ? `${analystUpside >= 0 ? "+" : ""}${analystUpside.toFixed(1)}%` : ""}
                    </span>
                  </div>
                </div>
              )}

              {/* Entry target + thesis */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: item.thesis ? 10 : 0 }}>
                <span style={{ fontSize: 10, color: "#333", textTransform: "uppercase", letterSpacing: 1 }}>Entry target:</span>
                <input
                  defaultValue={item.target || ""}
                  onBlur={e => updateTarget(item.symbol, e.target.value)}
                  placeholder="$ entry price"
                  style={{ background: "transparent", border: "none", borderBottom: "1px solid #222", color: "#f5c842", fontFamily: "monospace", fontSize: 12, width: 90, padding: "2px 4px", outline: "none" }}/>
                {atTarget && <Badge color="#00e5a0">🎯 BEREIKT</Badge>}
                <button onClick={() => remove(item.symbol)} style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#2a2a2a", cursor: "pointer", padding: "2px 6px" }}
                  onMouseEnter={e => e.currentTarget.style.color = "#ff6b6b"}
                  onMouseLeave={e => e.currentTarget.style.color = "#2a2a2a"}>
                  <Icon name="trash" size={12}/>
                </button>
              </div>
              {item.thesis && (
                <div style={{ fontSize: 11, color: "#444", fontStyle: "italic", borderLeft: "2px solid #1a1a1a", paddingLeft: 10 }}>{item.thesis}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Portfolio ─────────────────────────────────────────────────────────────────
const DEFAULT_POSITIONS = [
  { symbol: "ASML", shares: 10, avgCost: 680, thesis: "Core holding — insider visibility on tool demand" },
  { symbol: "TSM", shares: 20, avgCost: 150, thesis: "Foundry monopoly, AI wafer ramp thesis" },
  { symbol: "MU", shares: 30, avgCost: 95, thesis: "HBM supercycle, best value pick" },
  { symbol: "MRVL", shares: 40, avgCost: 65, thesis: "NVIDIA NVLink Fusion — re-rating event" },
  { symbol: "POWL", shares: 15, avgCost: 200, thesis: "Data center power infrastructure" },
  { symbol: "CLS", shares: 25, avgCost: 55, thesis: "AI infrastructure buildout" },
];

function PortfolioTab({ positions, setPositions }) {
  const [quotes, setQuotes] = useState({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ symbol: "", shares: "", avgCost: "", thesis: "" });

  const refresh = async () => {
    setLoading(true);
    const out = {};
    for (const p of positions) {
      const data = await yahooQuote(p.symbol);
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) out[p.symbol] = { price: meta.regularMarketPrice };
    }
    setQuotes(out); setLoading(false);
  };

  useEffect(() => { if (positions.length) refresh(); }, [positions.length]);

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

  return (
    <div>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
        <span style={{ color: "#444", fontSize: 12, fontFamily: "monospace" }}>{positions.length} positions · Supabase</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={refresh} disabled={loading} style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: loading ? "#2a2a2a" : "#555", padding: "7px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {loading ? <Spinner/> : <Icon name="refresh" size={13}/>} Refresh
          </button>
          <button onClick={() => setAdding(true)} style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
            <Icon name="plus" size={13}/> Position
          </button>
        </div>
      </div>
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
      <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr 60px", padding: "10px 20px", borderBottom: "1px solid #141414" }}>
          {["Position", "Shares", "Avg $", "Price", "Value", "P&L", "Return", ""].map((h, i) => (
            <div key={i} style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: "monospace", textAlign: i === 7 ? "right" : "left" }}>{h}</div>
          ))}
        </div>
        {positions.map(p => {
          const q = quotes[p.symbol];
          const price = q?.price || 0;
          const value = p.shares * price;
          const cost = p.shares * p.avgCost;
          const pl = value - cost;
          const rt = cost ? (pl / cost) * 100 : 0;
          return (
            <div key={p.symbol} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr 60px", padding: "13px 20px", borderBottom: "1px solid #0c0c0c", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#0b0b0b"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div>
                <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#e0e0e0" }}>{p.symbol}</div>
                {p.thesis && <div style={{ fontSize: 10, color: "#3a3a3a", marginTop: 2, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.thesis}</div>}
              </div>
              <div style={{ fontFamily: "monospace", color: "#666", fontSize: 13 }}>{p.shares}</div>
              <div style={{ fontFamily: "monospace", color: "#666", fontSize: 13 }}>{fmt.price(p.avgCost)}</div>
              <div style={{ fontFamily: "monospace", color: "#d0d0d0", fontSize: 13 }}>{price ? fmt.price(price) : <Spinner/>}</div>
              <div style={{ fontFamily: "monospace", color: "#888", fontSize: 13 }}>{value ? `$${value.toFixed(0)}` : "—"}</div>
              <div style={{ fontFamily: "monospace", color: pl >= 0 ? "#00e5a0" : "#ff6b6b", fontSize: 13, fontWeight: 600 }}>{pl ? `${pl >= 0 ? "+" : ""}$${pl.toFixed(0)}` : "—"}</div>
              <div style={{ fontFamily: "monospace", color: rt >= 0 ? "#00e5a0" : "#ff6b6b", fontSize: 13, fontWeight: 600 }}>{rt ? fmt.pct(rt) : "—"}</div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => remove(p.symbol)} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 6, color: "#444", padding: "5px 7px", cursor: "pointer" }}><Icon name="trash" size={12}/></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Markt Tab ─────────────────────────────────────────────────────────────────
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
    { id: "markt", label: "Market", icon: "chart" },
    { id: "shortlist", label: `Shortlist${shortlist.length ? ` (${shortlist.length})` : ""}`, icon: "star" },
    { id: "portfolio", label: "Portfolio", icon: "briefcase" },
    { id: "peg", label: "PEG Chart", icon: "chart" },
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
                {tab === "peg" && "PEG History"}
              </h1>
              <p style={{ color: "#2a2a2a", fontSize: 12, marginTop: 3 }}>
                {tab === "markt" && "Rational macro context · VIX · Fear & Greed · Yields · Sentiment"}
                {tab === "shortlist" && "52-week position · analyst targets · entry signal per stock"}
                {tab === "portfolio" && "Live P&L · positions synced with Supabase"}
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
            <div style={{ display: tab === "peg" ? "block" : "none" }}>
              <PEGChartTab portfolioSymbols={positions.map(p => p.symbol)}/>
            </div>
          </>
        )}
      </div>
    </div>
  );
}