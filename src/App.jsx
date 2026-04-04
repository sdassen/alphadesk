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
          <div style={{ color: "#888", fontFamily: "monospace", fontSize: 14, marginBottom: 12 }}>Nog geen PEG history</div>
          <div style={{ color: "#444", fontSize: 12, lineHeight: 1.8 }}>
            De grafiek vult zich automatisch op via dagelijkse scans.<br/>
            Elke keer dat je de Scanner gebruikt wordt een snapshot opgeslagen.<br/>
            <span style={{ color: "#333" }}>Na een paar scans verschijnen hier betrouwbare trendlijnen.</span>
          </div>
        </div>
      ) : (
        <>
          <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", padding: "24px 20px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#333", marginBottom: 16, fontFamily: "monospace" }}>
              PEG ratio over time · {chartData.length} datapunten · groeit bij elke scan
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
                  <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>Huidige PEG</div>
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

// ── Scanner ───────────────────────────────────────────────────────────────────
const COLS = "2.5fr 1fr 1fr 1.8fr 1fr 1fr 1fr 1fr 1fr 80px";

const roicColor = (v) => v == null ? "#555" : v >= 20 ? "#00e5a0" : v >= 15 ? "#f5c842" : "#ff6b6b";
const ndColor   = (v) => v == null ? "#555" : v <= 1  ? "#00e5a0" : v <= 2  ? "#f5c842" : "#ff6b6b";
const fcfColor  = (v) => v == null ? "#555" : v >= 15 ? "#00e5a0" : v >= 8  ? "#f5c842" : "#ff6b6b";
const shortColor= (v) => v == null ? "#555" : v >= 20 ? "#ff6b6b" : v >= 10 ? "#f5c842" : "#666";
const evColor   = (v) => v == null ? "#555" : v <= 15 ? "#00e5a0" : v <= 30  ? "#f5c842" : "#ff6b6b";

const TableHeader = () => (
  <div style={{ display: "grid", gridTemplateColumns: COLS, padding: "10px 20px", borderBottom: "1px solid #1a1a1a" }}>
    {["Symbol / Naam", "Price", "Chg%", "PEG", "fwd P/E", "EPS Grw", "Gr.Mgn", "ROIC", "ND/EBITDA", ""].map((h, i) => (
      <div key={i} style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 700, letterSpacing: 1.1, textTransform: "uppercase", fontFamily: "monospace", textAlign: i === 9 ? "right" : "left" }}>{h}</div>
    ))}
  </div>
);

const StockRow = ({ stock, actions }) => (
  <div style={{ borderBottom: "1px solid #0e0e0e", transition: "background 0.15s" }}
    onMouseEnter={e => e.currentTarget.style.background = "#0b0b0b"}
    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
    {/* Primary row */}
    <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "11px 20px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {stock.logo && <img src={stock.logo} alt="" style={{ width: 26, height: 26, borderRadius: 6, objectFit: "contain", background: "#141414", padding: 2 }} onError={e => e.target.style.display="none"}/>}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#fff" }}>{stock.symbol}</span>
            {stock.pegSource && <span style={{ fontSize: 9, color: "#333", border: "1px solid #1e1e1e", borderRadius: 3, padding: "1px 4px", fontFamily: "monospace" }}>{stock.pegSource}</span>}
          </div>
          <div style={{ fontSize: 11, color: "#777", marginTop: 1, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stock.name}</div>
        </div>
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 13, color: "#d0d0d0" }}>{fmt.price(stock.price)}</div>
      <div style={{ fontFamily: "monospace", fontSize: 13, color: stock.change >= 0 ? "#00e5a0" : "#ff6b6b", fontWeight: 600 }}>{fmt.pct(stock.change)}</div>
      <PEGBar peg={stock.peg}/>
      <div style={{ fontFamily: "monospace", fontSize: 12, color: stock.forwardPE && stock.forwardPE < 25 ? "#00e5a0" : stock.forwardPE < 40 ? "#f5c842" : "#ff6b6b" }}>{fmt.num(stock.forwardPE)}</div>
      <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.pct(stock.epsGrowth)}</div>
      <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.pct(stock.grossMargin)}</div>
      <div style={{ fontFamily: "monospace", fontSize: 12, color: roicColor(stock.roic), fontWeight: 600 }}>{stock.roic != null ? fmt.pct(stock.roic) : "—"}</div>
      <div style={{ fontFamily: "monospace", fontSize: 12, color: ndColor(stock.netDebtEbitda), fontWeight: 600 }}>{stock.netDebtEbitda != null ? fmt.num(stock.netDebtEbitda) : "—"}</div>
      <div style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
        {actions.map((a, i) => (
          <button key={i} onClick={() => a.fn(stock)} title={a.label}
            style={{ background: "#141414", border: "1px solid #222", borderRadius: 6, color: a.color || "#555", padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = a.color || "#444"; e.currentTarget.style.color = a.color || "#ccc"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = a.color || "#555"; }}>
            <Icon name={a.icon} size={12}/>
          </button>
        ))}
      </div>
    </div>
    {/* Secondary row: FCF Margin, FCF Yield, EV/EBITDA, Short % */}
    <div style={{ display: "flex", gap: 20, padding: "3px 20px 10px", paddingLeft: stock.logo ? 76 : 20 }}>
      {[
        ["FCF Mgn", stock.fcfMargin != null ? fmt.pct(stock.fcfMargin) : "—", fcfColor(stock.fcfMargin)],
        ["FCF Yield", stock.fcfYield != null ? fmt.pct(stock.fcfYield) : "—", fcfColor(stock.fcfYield)],
        ["EV/EBITDA", stock.evEbitda != null ? fmt.num(stock.evEbitda) : "—", evColor(stock.evEbitda)],
        ["Short%", stock.shortPct != null ? fmt.pct(stock.shortPct) : "—", shortColor(stock.shortPct)],
        ["Op.Mgn", stock.operatingMargin != null ? fmt.pct(stock.operatingMargin) : "—", "#555"],
        ["Rev Grw", fmt.pct(stock.revenueGrowth), "#555"],
      ].map(([label, val, color]) => (
        <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: 9, color: "#333", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "monospace" }}>{label}</span>
          <span style={{ fontSize: 11, color, fontFamily: "monospace", fontWeight: 600 }}>{val}</span>
        </div>
      ))}
    </div>
  </div>
);

function ScannerTab({ onAddToShortlist, portfolioSymbols, shortlistSymbols, scanResults, setScanResults }) {
  const [universe, setUniverse] = useState([]);
  const [customInput, setCustomInput] = useState("");
  const [filters, setFilters] = useState({ pegMax: 2, peMax: 40, epsGrowthMin: 10, grossMarginMin: 30, roicMin: 15, netDebtEbitdaMax: 2, evEbitdaMax: 30, fcfMarginMin: 0 });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [scanned, setScanned] = useState(0);
  const [total, setTotal] = useState(0);

  // Load universe from DB on mount
  useEffect(() => {
    SB.from("scan_universe").select("symbol").eq("active", true).order("symbol").then(({ data }) => {
      setUniverse((data || []).map(r => r.symbol));
    });
  }, []);

  const scan = async () => {
    const extras = customInput.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    const syms = [...new Set([...universe, ...extras])];
    setLoading(true); setScanResults([]); setScanned(0); setTotal(syms.length);
    const out = [];
    for (let i = 0; i < syms.length; i++) {
      const sym = syms[i];
      setProgress(sym); setScanned(i + 1);
      try {
        const d = await fetchFull(sym);
        if (d) {
          out.push(d);
          if (d.peg) db.savePegSnapshot(d.symbol, d.peg, d.pe, d.price, d.epsGrowth).catch(() => {});
        }
      } catch (e) { /* skip failed */ }
    }
    setLoading(false); setProgress(""); setScanned(0);
    setScanResults(out.sort((a, b) => (a.peg ?? 99) - (b.peg ?? 99)));
  };

  const filtered = scanResults.filter(s =>
    (s.peg == null || s.peg <= filters.pegMax) &&
    (s.forwardPE == null || s.forwardPE <= filters.peMax) &&
    s.epsGrowth >= filters.epsGrowthMin &&
    s.grossMargin >= filters.grossMarginMin &&
    (s.roic == null || s.roic >= filters.roicMin) &&
    (s.netDebtEbitda == null || s.netDebtEbitda <= filters.netDebtEbitdaMax) &&
    (s.evEbitda == null || s.evEbitda <= filters.evEbitdaMax) &&
    (s.fcfMargin == null || s.fcfMargin >= filters.fcfMarginMin)
  );

  return (
    <div>
      {/* Universe info + scan controls */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase" }}>Scan universum</div>
            <Badge color="#555">{universe.length} stocks</Badge>
          </div>
          <div style={{ fontSize: 11, color: "#333", marginBottom: 10 }}>
            Tech · Semi · Cloud · AI Infrastructure · Power · Fintech
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#444", marginBottom: 4, letterSpacing: 1, textTransform: "uppercase" }}>Extra symbols toevoegen (optioneel)</div>
            <input value={customInput} onChange={e => setCustomInput(e.target.value)}
              placeholder="bijv. ARM, SMCI, ..."
              style={{ width: 280, background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 6, color: "#d0d0d0", padding: "7px 13px", fontSize: 13, fontFamily: "monospace" }}/>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <button onClick={scan} disabled={loading || universe.length === 0}
            style={{ background: loading ? "#0d0d0d" : "#00e5a0", color: loading ? "#333" : "#000", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: "monospace", transition: "all 0.2s" }}>
            {loading ? <Spinner/> : <Icon name="scan" size={14}/>}
            {loading ? `${progress} (${scanned}/${total})` : `Scan ${universe.length} stocks`}
          </button>
          {loading && (
            <div style={{ width: "100%", height: 3, background: "#1a1a1a", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${total ? (scanned / total) * 100 : 0}%`, height: "100%", background: "#00e5a0", transition: "width 0.3s ease", borderRadius: 2 }}/>
            </div>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          ["PEG ≤", "pegMax", 0.1], ["fwd P/E ≤", "peMax", 1],
          ["EPS Grw ≥%", "epsGrowthMin", 1], ["Gross Mgn ≥%", "grossMarginMin", 1],
          ["ROIC ≥%", "roicMin", 1], ["ND/EBITDA ≤", "netDebtEbitdaMax", 0.1],
          ["EV/EBITDA ≤", "evEbitdaMax", 1], ["FCF Mgn ≥%", "fcfMarginMin", 1],
        ].map(([label, key, step]) => (
          <div key={key}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
            <input type="number" step={step} value={filters[key]} onChange={e => setFilters(p => ({ ...p, [key]: parseFloat(e.target.value) }))}
              style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 6, color: "#d0d0d0", padding: "7px 11px", width: 90, fontSize: 13, fontFamily: "monospace" }}/>
          </div>
        ))}
      </div>

      {/* Results */}
      {scanResults.length > 0 && (
        <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #181818", overflow: "hidden" }}>
          <div style={{ padding: "11px 20px", borderBottom: "1px solid #181818", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#3a3a3a", fontFamily: "monospace" }}>
              {filtered.length} voldoen aan filters van {scanResults.length} gescand · ★ = in portfolio/shortlist
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <Badge color="#00e5a0">PEG &lt;0.8</Badge>
              <Badge color="#f5c842">0.8–1.5</Badge>
              <Badge color="#ff6b6b">&gt;1.5</Badge>
            </div>
          </div>
          <TableHeader/>
          {filtered.map(s => {
            const inPortfolio = portfolioSymbols.includes(s.symbol);
            const inShortlist = shortlistSymbols.includes(s.symbol);
            return <StockRow key={s.symbol} stock={{ ...s, inPortfolio, inShortlist }} actions={[
              { label: "Add to Shortlist", icon: "star", color: inShortlist ? "#00e5a0" : "#f5c842", fn: onAddToShortlist }
            ]}/>;
          })}
          {filtered.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#2a2a2a", fontFamily: "monospace" }}>Geen stocks voldoen aan de filters</div>}
        </div>
      )}
    </div>
  );
}

// ── Shortlist ─────────────────────────────────────────────────────────────────
function ShortlistTab({ shortlist, setShortlist }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ symbol: "", target: "", thesis: "" });
  const [stocks, setStocks] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const out = {};
    for (const item of shortlist) { const d = await fetchFull(item.symbol); if (d) out[item.symbol] = d; }
    setStocks(out); setRefreshing(false);
  }, [shortlist]);

  useEffect(() => { if (shortlist.length) refresh(); }, [shortlist.length]);

  const add = async () => {
    if (!form.symbol) return;
    const entry = { symbol: form.symbol.toUpperCase(), target: parseFloat(form.target) || null, thesis: form.thesis, status: "Watching" };
    await db.upsertShortlist(entry);
    setShortlist(p => p.find(s => s.symbol === entry.symbol) ? p : [...p, { ...entry, addedAt: Date.now() }]);
    setAdding(false); setForm({ symbol: "", target: "", thesis: "" });
    const d = await fetchFull(entry.symbol);
    if (d) { setStocks(p => ({ ...p, [entry.symbol]: d })); if (d.peg) db.savePegSnapshot(entry.symbol, d.peg, d.pe, d.price, d.epsGrowth).catch(() => {}); }
  };

  const remove = async (sym) => { await db.deleteShortlist(sym); setShortlist(p => p.filter(s => s.symbol !== sym)); };
  const updateStatus = async (sym, status) => { await db.updateShortlistStatus(sym, status); setShortlist(p => p.map(s => s.symbol === sym ? { ...s, status } : s)); };

  const STATUSES = ["Watching", "Ready to Buy", "Bought", "Exited"];
  const statusColor = { "Watching": "#444", "Ready to Buy": "#f5c842", "Bought": "#00e5a0", "Exited": "#ff6b6b" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <span style={{ color: "#444", fontSize: 12, fontFamily: "monospace" }}>{shortlist.length} on shortlist · Supabase</span>
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
          <div>Shortlist empty — scan and add stocks</div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {shortlist.map(item => {
          const s = stocks[item.symbol];
          const atTarget = s && item.target && s.price <= item.target;
          return (
            <div key={item.symbol} style={{ background: "#070707", border: `1px solid ${atTarget ? "#00e5a033" : "#141414"}`, borderRadius: 12, padding: "15px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {s?.logo && <img src={s.logo} alt="" style={{ width: 30, height: 30, borderRadius: 7, objectFit: "contain", background: "#111", padding: 3 }} onError={e => e.target.style.display="none"}/>}
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#fff" }}>{item.symbol}</span>
                      {atTarget && <Badge color="#00e5a0">🎯 AT TARGET</Badge>}
                    </div>
                    <div style={{ color: "#444", fontSize: 11, marginTop: 2 }}>{s?.name || "—"}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                  <select value={item.status} onChange={e => updateStatus(item.symbol, e.target.value)}
                    style={{ background: "#0d0d0d", border: `1px solid ${statusColor[item.status]}44`, borderRadius: 6, color: statusColor[item.status], padding: "5px 9px", fontSize: 12, fontFamily: "monospace", cursor: "pointer" }}>
                    {STATUSES.map(st => <option key={st}>{st}</option>)}
                  </select>
                  <button onClick={() => remove(item.symbol)} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 6, color: "#444", padding: "5px 7px", cursor: "pointer" }}><Icon name="trash" size={12}/></button>
                </div>
              </div>
              {s && (
                <div style={{ display: "flex", gap: 20, marginTop: 13, flexWrap: "wrap" }}>
                  {[["Price", fmt.price(s.price), s.change >= 0 ? "#00e5a0" : "#ff6b6b"],
                    ["Day", fmt.pct(s.change), s.change >= 0 ? "#00e5a0" : "#ff6b6b"],
                    ["PEG", fmt.num(s.peg), pegColor(s.peg)],
                    ["P/E", fmt.num(s.pe), "#666"],
                    ["EPS Grw", fmt.pct(s.epsGrowth), "#666"],
                    ["Entry", item.target ? fmt.price(item.target) : "—", "#f5c842"],
                    ["Gap", item.target && s.price ? fmt.pct(((item.target - s.price) / s.price) * 100) : "—", "#555"],
                  ].map(([label, val, color]) => (
                    <div key={label}>
                      <div style={{ fontSize: 9, color: "#333", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontFamily: "monospace", fontSize: 14, color, fontWeight: 600 }}>{val}</div>
                    </div>
                  ))}
                </div>
              )}
              {item.thesis && (
                <div style={{ marginTop: 11, background: "#0a0a0a", borderRadius: 6, padding: "7px 12px", borderLeft: "2px solid #1e1e1e" }}>
                  <span style={{ fontSize: 11, color: "#555", fontStyle: "italic" }}>{item.thesis}</span>
                </div>
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

// ── Universum Tab ─────────────────────────────────────────────────────────────
function UniversumTab() {
  const [universe, setUniverse] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [newSector, setNewSector] = useState("");
  const [search, setSearch] = useState("");
  const [collapsedSectors, setCollapsedSectors] = useState({});

  const load = async () => {
    setLoading(true);
    const { data } = await SB.from("scan_universe")
      .select("*")
      .order("sector").order("symbol");
    setUniverse(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Enrich: haal naam + market cap + revenue op via Yahoo voor alle ontbrekende entries
  const enrichAll = async () => {
    const missing = universe.filter(u => !u.name || !u.market_cap);
    if (!missing.length) return;
    setEnriching(true);
    for (const item of missing) {
      setEnrichProgress(`${item.symbol}…`);
      try {
        const data = await yahooSummary(item.symbol);
        const fin = data?.quoteSummary?.result?.[0];
        const fd = fin?.financialData || {};
        const sd = fin?.summaryDetail || {};
        const ap = fin?.assetProfile || {};
        const name = ap.longName || ap.shortName || null;
        const market_cap = sd.marketCap?.raw || null;
        const revenue = fd.totalRevenue?.raw || null;
        if (name || market_cap) {
          await SB.from("scan_universe").update({ name, market_cap, revenue }).eq("symbol", item.symbol);
          setUniverse(p => p.map(u => u.symbol === item.symbol ? { ...u, name, market_cap, revenue } : u));
        }
      } catch (e) { /* skip */ }
      await new Promise(r => setTimeout(r, 150)); // rate limit
    }
    setEnriching(false);
    setEnrichProgress("");
  };

  const addTicker = async () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    const sector = newSector.trim() || "Overig";
    await SB.from("scan_universe").upsert({ symbol: sym, sector, active: true }, { onConflict: "symbol" });
    setNewSymbol(""); setNewSector("");
    await load();
  };

  const removeTicker = async (symbol) => {
    await SB.from("scan_universe").delete().eq("symbol", symbol);
    setUniverse(p => p.filter(u => u.symbol !== symbol));
  };

  const toggleActive = async (symbol, active) => {
    await SB.from("scan_universe").update({ active: !active }).eq("symbol", symbol);
    setUniverse(p => p.map(u => u.symbol === symbol ? { ...u, active: !active } : u));
  };

  const toggleSector = (sector) => {
    setCollapsedSectors(p => ({ ...p, [sector]: !p[sector] }));
  };

  const fmt = {
    cap: (v) => !v ? "—" : v >= 1e12 ? `$${(v/1e12).toFixed(1)}T` : v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : `$${(v/1e6).toFixed(0)}M`,
  };

  const filtered = universe.filter(u =>
    u.symbol.includes(search.toUpperCase()) ||
    (u.name || "").toLowerCase().includes(search.toLowerCase())
  );

  // Group by sector
  const sectors = {};
  for (const u of filtered) {
    if (!sectors[u.sector]) sectors[u.sector] = [];
    sectors[u.sector].push(u);
  }

  const activeCount = universe.filter(u => u.active !== false).length;
  const enrichedCount = universe.filter(u => u.name).length;

  return (
    <div>
      {/* Header controls */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoek op ticker of naam…"
            style={{ width: "100%", maxWidth: 300, background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: "#d0d0d0", padding: "8px 13px", fontSize: 13, fontFamily: "monospace" }}/>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap', alignItems: 'center" }}>
          <span style={{ fontSize: 11, color: "#444", fontFamily: "monospace", alignSelf: "center" }}>
            {activeCount}/{universe.length} actief · {enrichedCount} verrijkt
          </span>
          <button onClick={enrichAll} disabled={enriching}
            style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: enriching ? "#333" : "#555", padding: "7px 13px", cursor: enriching ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {enriching ? <Spinner/> : <Icon name="refresh" size={13}/>}
            {enriching ? enrichProgress : "Verrijk namen & omzet"}
          </button>
        </div>
      </div>

      {/* Add ticker */}
      <div style={{ background: "#070707", border: "1px solid #1a1a1a", borderRadius: 10, padding: "14px 18px", marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Ticker</div>
          <input value={newSymbol} onChange={e => setNewSymbol(e.target.value)} placeholder="AAPL"
            onKeyDown={e => e.key === "Enter" && addTicker()}
            style={{ width: 90, background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, color: "#d0d0d0", padding: "7px 11px", fontSize: 13, fontFamily: "monospace" }}/>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Sector</div>
          <input value={newSector} onChange={e => setNewSector(e.target.value)} placeholder="bijv. Semiconductors"
            onKeyDown={e => e.key === "Enter" && addTicker()}
            style={{ width: 180, background: "#0d0d0d", border: "1px solid #222", borderRadius: 6, color: "#d0d0d0", padding: "7px 11px", fontSize: 13, fontFamily: "monospace" }}/>
        </div>
        <button onClick={addTicker}
          style={{ background: "#00e5a0", border: "none", borderRadius: 8, color: "#000", padding: "7px 16px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <Icon name="plus" size={13}/> Toevoegen
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#333", fontFamily: "monospace", padding: "40px 0" }}><Spinner/> Laden…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Object.entries(sectors).sort().map(([sector, tickers]) => {
            const collapsed = collapsedSectors[sector];
            const sectorActive = tickers.filter(t => t.active !== false).length;
            return (
              <div key={sector} style={{ background: "#070707", border: "1px solid #141414", borderRadius: 10, overflow: "hidden" }}>
                {/* Sector header */}
                <div onClick={() => toggleSector(sector)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", cursor: "pointer", userSelect: "none" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#0d0d0d"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#e0e0e0" }}>{sector}</span>
                    <span style={{ fontSize: 11, color: "#444", fontFamily: "monospace" }}>{sectorActive}/{tickers.length} actief</span>
                  </div>
                  <span style={{ color: "#333", fontSize: 12 }}>{collapsed ? "▶" : "▼"}</span>
                </div>

                {/* Ticker rows */}
                {!collapsed && (
                  <div>
                    {/* Column header */}
                    <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 120px 120px 80px 60px", gap: 0, padding: "6px 18px", borderTop: "1px solid #111", borderBottom: "1px solid #111" }}>
                      {["Ticker", "Naam", "Market Cap", "Omzet", "Actief", ""].map((h, i) => (
                        <div key={i} style={{ fontSize: 9, color: "#333", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: "monospace", textAlign: i >= 4 ? "center" : "left" }}>{h}</div>
                      ))}
                    </div>
                    {tickers.map(ticker => (
                      <div key={ticker.symbol}
                        style={{ display: "grid", gridTemplateColumns: "80px 1fr 120px 120px 80px 60px", alignItems: "center", padding: "9px 18px", borderBottom: "1px solid #0c0c0c", opacity: ticker.active === false ? 0.4 : 1, transition: "opacity 0.2s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "#0b0b0b"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#fff" }}>{ticker.symbol}</div>
                        <div style={{ fontSize: 12, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 }}>{ticker.name || <span style={{ color: "#333" }}>—</span>}</div>
                        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.cap(ticker.market_cap)}</div>
                        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.cap(ticker.revenue)}</div>
                        <div style={{ textAlign: "center" }}>
                          <button onClick={() => toggleActive(ticker.symbol, ticker.active !== false)}
                            style={{ background: ticker.active !== false ? "#00e5a022" : "#1a1a1a", border: `1px solid ${ticker.active !== false ? "#00e5a044" : "#222"}`, borderRadius: 5, color: ticker.active !== false ? "#00e5a0" : "#444", padding: "3px 8px", cursor: "pointer", fontSize: 10, fontFamily: "monospace" }}>
                            {ticker.active !== false ? "aan" : "uit"}
                          </button>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <button onClick={() => removeTicker(ticker.symbol)}
                            style={{ background: "transparent", border: "none", color: "#333", cursor: "pointer", padding: "3px 6px" }}
                            onMouseEnter={e => e.currentTarget.style.color = "#ff6b6b"}
                            onMouseLeave={e => e.currentTarget.style.color = "#333"}>
                            <Icon name="trash" size={12}/>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("scanner");
  const [shortlist, setShortlist] = useState([]);
  const [positions, setPositions] = useState([]);
  const [booting, setBooting] = useState(true);
  // Scanresultaten leven in App zodat ze bewaard blijven bij tab-wissels
  const [scanResults, setScanResults] = useState([]);

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
    { id: "scanner", label: "Scanner", icon: "scan" },
    { id: "shortlist", label: `Shortlist${shortlist.length ? ` (${shortlist.length})` : ""}`, icon: "star" },
    { id: "portfolio", label: "Portfolio", icon: "briefcase" },
    { id: "peg", label: "PEG Chart", icon: "chart" },
    { id: "universum", label: "Universum", icon: "db" },
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
                {tab === "scanner" && "Stock Scanner"}
                {tab === "shortlist" && "Shortlist"}
                {tab === "portfolio" && "Portfolio"}
                {tab === "peg" && "PEG History"}
                {tab === "universum" && "Scan Universum"}
              </h1>
              <p style={{ color: "#2a2a2a", fontSize: 12, marginTop: 3 }}>
                {tab === "scanner" && "Scant je portfolio + shortlist · PEG snapshots auto-saved"}
                {tab === "shortlist" && "Entry targets & thesis · persisted in Supabase"}
                {tab === "portfolio" && "Live P&L · positions synced to Supabase"}
                {tab === "peg" && "PEG over time · seed 120 days or build daily via scanner"}
                {tab === "universum" && "Beheer welke tickers gescand worden · per sector georganiseerd"}
              </p>
            </div>
            {/* Tabs blijven gemount — display:none ipv unmounten zodat scan state bewaard blijft */}
            <div style={{ display: tab === "scanner" ? "block" : "none" }}>
              <ScannerTab onAddToShortlist={addToShortlist} portfolioSymbols={positions.map(p => p.symbol)} shortlistSymbols={shortlist.map(s => s.symbol)} scanResults={scanResults} setScanResults={setScanResults}/>
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
            <div style={{ display: tab === "universum" ? "block" : "none" }}>
              <UniversumTab/>
            </div>
          </>
        )}
      </div>
    </div>
  );
}