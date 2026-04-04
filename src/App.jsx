import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend
} from "recharts";

// ── Config ────────────────────────────────────────────────────────────────────
const FMP_KEY = "Fs4tEUlKjGXH8TKQO32olCKH9w8gBIgG";
const FMP = "https://financialmodelingprep.com/api/v3";
const SB = createClient(
  "https://jnuhyhjwoevoleezshum.supabase.co",
  "sb_publishable_8_2sGbwdbgQmptBsh3iUoQ_Dem-WaKv"
);

// ── FMP ───────────────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const r = await fetch(`${FMP}/quote/${symbol}?apikey=${FMP_KEY}`);
  const d = await r.json();
  return d[0] || null;
}
async function fetchProfile(symbol) {
  const r = await fetch(`${FMP}/profile/${symbol}?apikey=${FMP_KEY}`);
  const d = await r.json();
  return d[0] || null;
}
async function fetchKeyMetrics(symbol) {
  const r = await fetch(`${FMP}/key-metrics-ttm/${symbol}?apikey=${FMP_KEY}`);
  const d = await r.json();
  return d[0] || null;
}
async function fetchGrowth(symbol) {
  const r = await fetch(`${FMP}/financial-growth/${symbol}?limit=1&apikey=${FMP_KEY}`);
  const d = await r.json();
  return d[0] || null;
}

// Fetch historical daily prices (free endpoint) for PEG bootstrap
async function fetchHistoricalPrices(symbol, days = 90) {
  const r = await fetch(`${FMP}/historical-price-full/${symbol}?timeseries=${days}&apikey=${FMP_KEY}`);
  const d = await r.json();
  return d.historical || [];
}

async function fetchFull(symbol) {
  const [quote, profile, metrics, growth] = await Promise.all([
    fetchQuote(symbol), fetchProfile(symbol), fetchKeyMetrics(symbol), fetchGrowth(symbol)
  ]);
  if (!quote) return null;
  const epsGrowth = growth?.epsgrowth || growth?.epsGrowth || 0;
  const peRatio = quote.pe || null;
  const peg = peRatio && epsGrowth ? peRatio / (epsGrowth * 100) : null;
  return {
    symbol: symbol.toUpperCase(),
    name: profile?.companyName || quote.name || symbol,
    price: quote.price,
    change: quote.changesPercentage,
    pe: peRatio,
    peg,
    epsGrowth: epsGrowth * 100,
    revenueGrowth: (growth?.revenueGrowth || 0) * 100,
    grossMargin: (metrics?.grossProfitMarginTTM || 0) * 100,
    marketCap: quote.marketCap,
    sector: profile?.sector || "—",
    logo: profile?.image || null,
    currentEpsGrowth: epsGrowth, // raw for bootstrap
  };
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
  const [seeding, setSeeding] = useState(false);
  const [seedProgress, setSeedProgress] = useState("");
  const [chartData, setChartData] = useState([]);

  const loadHistory = async () => {
    setLoading(true);
    const raw = await db.getAllPegHistory();

    // Group by symbol
    const bySymbol = {};
    for (const row of raw) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = {};
      bySymbol[row.symbol][row.date] = parseFloat(row.peg?.toFixed(3));
    }
    setAllHistory(bySymbol);

    const syms = Object.keys(bySymbol);
    setAvailableSymbols(syms);
    // Auto-select portfolio symbols that have data
    const toSelect = portfolioSymbols.filter(s => syms.includes(s));
    setSelectedSymbols(toSelect.length ? toSelect : syms.slice(0, 4));
    setLoading(false);
  };

  useEffect(() => { loadHistory(); }, []);

  // Build chart data: unified date axis
  useEffect(() => {
    if (!Object.keys(allHistory).length || !selectedSymbols.length) { setChartData([]); return; }
    const dateSet = new Set();
    for (const sym of selectedSymbols) {
      if (allHistory[sym]) Object.keys(allHistory[sym]).forEach(d => dateSet.add(d));
    }
    const dates = [...dateSet].sort();
    const data = dates.map(date => {
      const row = { date: date.slice(5) }; // MM-DD
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

  // Seed historical data using price history + current EPS growth as approximation
  const seedHistory = async () => {
    setSeeding(true);
    const symsToSeed = portfolioSymbols.length ? portfolioSymbols : ["ASML", "TSM", "MU", "MRVL", "POWL", "CLS"];
    let totalInserted = 0;
    for (const sym of symsToSeed) {
      setSeedProgress(`Seeding ${sym}…`);
      const [full, prices] = await Promise.all([fetchFull(sym), fetchHistoricalPrices(sym, 120)]);
      if (full && prices.length && full.pe && full.currentEpsGrowth) {
        const n = await db.seedHistory(sym, prices, full.currentEpsGrowth, full.pe, full.price);
        totalInserted += n;
        // Also save today's snapshot
        if (full.peg) await db.savePegSnapshot(sym, full.peg, full.pe, full.price, full.epsGrowth).catch(() => {});
      }
    }
    setSeedProgress("");
    setSeeding(false);
    await loadHistory();
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
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={loadHistory} disabled={loading}
            style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: loading ? "#2a2a2a" : "#555", padding: "7px 13px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            {loading ? <Spinner/> : <Icon name="refresh" size={13}/>} Refresh
          </button>
          <button onClick={seedHistory} disabled={seeding}
            style={{ background: seeding ? "#0a0a0a" : "#0d1a14", border: "1px solid #00e5a033", borderRadius: 8, color: seeding ? "#2a2a2a" : "#00e5a0", padding: "7px 14px", cursor: seeding ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
            {seeding ? <Spinner/> : <Icon name="seed" size={13}/>}
            {seeding ? seedProgress || "Seeding…" : "Seed 120d history"}
          </button>
        </div>
      </div>

      {/* Legend: PEG zones */}
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
          <div style={{ fontSize: 28, marginBottom: 12 }}>📈</div>
          <div style={{ color: "#2a2a2a", fontFamily: "monospace", marginBottom: 16 }}>No PEG history yet</div>
          <div style={{ color: "#444", fontSize: 12, marginBottom: 20 }}>
            Two ways to get data:<br/>
            <span style={{ color: "#555" }}>1. Scan daily — snapshots auto-save</span><br/>
            <span style={{ color: "#555" }}>2. Click "Seed 120d history" for a bootstrapped estimate</span>
          </div>
          <button onClick={seedHistory} disabled={seeding}
            style={{ background: "#0d1a14", border: "1px solid #00e5a044", borderRadius: 8, color: "#00e5a0", padding: "10px 20px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
            {seeding ? <Spinner/> : <Icon name="seed" size={14}/>}
            {seeding ? seedProgress : "Seed 120 days of history"}
          </button>
          <div style={{ color: "#2a2a2a", fontSize: 11, marginTop: 12 }}>Uses current EPS growth as proxy for historical PEG estimate</div>
        </div>
      ) : (
        <>
          {/* Main chart */}
          <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #141414", padding: "24px 20px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#333", marginBottom: 16, fontFamily: "monospace" }}>
              PEG ratio over time · {chartData.length} data points
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#111" vertical={false}/>
                <XAxis dataKey="date" tick={{ fill: "#333", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                <YAxis tick={{ fill: "#333", fontSize: 10, fontFamily: "monospace" }} tickLine={false} axisLine={false} domain={[0, "auto"]}/>
                {/* PEG zone bands */}
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

          {/* Per-symbol current PEG summary */}
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
                  <div style={{ fontSize: 10, color: "#2a2a2a", marginTop: 2 }}>{history.length} data points</div>
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
const COLS = "2fr 1fr 1fr 1.5fr 1fr 1fr 1fr 1fr 90px";
const TableHeader = () => (
  <div style={{ display: "grid", gridTemplateColumns: COLS, padding: "10px 20px", borderBottom: "1px solid #1a1a1a" }}>
    {["Symbol", "Price", "Chg%", "PEG", "P/E", "EPS Grw", "Margin", "Sector", ""].map((h, i) => (
      <div key={i} style={{ fontSize: 10, color: "#3a3a3a", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: "monospace", textAlign: i === 8 ? "right" : "left" }}>{h}</div>
    ))}
  </div>
);
const StockRow = ({ stock, actions }) => (
  <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", padding: "13px 20px", borderBottom: "1px solid #0e0e0e", transition: "background 0.15s" }}
    onMouseEnter={e => e.currentTarget.style.background = "#0b0b0b"}
    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {stock.logo && <img src={stock.logo} alt="" style={{ width: 26, height: 26, borderRadius: 6, objectFit: "contain", background: "#141414", padding: 2 }} onError={e => e.target.style.display="none"}/>}
      <div>
        <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, color: "#fff" }}>{stock.symbol}</div>
        <div style={{ fontSize: 10, color: "#444", marginTop: 1, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stock.name}</div>
      </div>
    </div>
    <div style={{ fontFamily: "monospace", fontSize: 13, color: "#d0d0d0" }}>{fmt.price(stock.price)}</div>
    <div style={{ fontFamily: "monospace", fontSize: 13, color: stock.change >= 0 ? "#00e5a0" : "#ff6b6b", fontWeight: 600 }}>{fmt.pct(stock.change)}</div>
    <PEGBar peg={stock.peg}/>
    <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.num(stock.pe)}</div>
    <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.pct(stock.epsGrowth)}</div>
    <div style={{ fontFamily: "monospace", fontSize: 12, color: "#666" }}>{fmt.pct(stock.grossMargin)}</div>
    <div><Badge color={stock.peg < 1 ? "#00e5a0" : stock.peg < 1.5 ? "#f5c842" : "#ff6b6b"}>{(stock.sector || "—").split(" ")[0]}</Badge></div>
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
);

function ScannerTab({ onAddToShortlist }) {
  const [input, setInput] = useState("ASML, TSM, MU, MRVL, POWL, CLS, NVDA, AMD, AMAT, LRCX");
  const [filters, setFilters] = useState({ pegMax: 2, peMax: 40, epsGrowthMin: 10, grossMarginMin: 30 });
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");

  const scan = async () => {
    const syms = input.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    setLoading(true); setResults([]);
    const out = [];
    for (const sym of syms) {
      setProgress(`Fetching ${sym}…`);
      const d = await fetchFull(sym);
      if (d) {
        out.push(d);
        if (d.peg) db.savePegSnapshot(d.symbol, d.peg, d.pe, d.price, d.epsGrowth).catch(() => {});
      }
    }
    setLoading(false); setProgress("");
    setResults(out.sort((a, b) => (a.peg ?? 99) - (b.peg ?? 99)));
  };

  const filtered = results.filter(s =>
    (s.peg == null || s.peg <= filters.pegMax) &&
    (s.pe == null || s.pe <= filters.peMax) &&
    s.epsGrowth >= filters.epsGrowthMin &&
    s.grossMargin >= filters.grossMarginMin
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 10, color: "#444", marginBottom: 5, letterSpacing: 1, textTransform: "uppercase" }}>Symbols</div>
          <textarea value={input} onChange={e => setInput(e.target.value)}
            style={{ width: "100%", background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, color: "#d0d0d0", padding: "9px 13px", fontSize: 13, fontFamily: "monospace", resize: "none", height: 50, boxSizing: "border-box" }}/>
        </div>
        <button onClick={scan} disabled={loading}
          style={{ marginTop: 21, background: loading ? "#0d0d0d" : "#00e5a0", color: loading ? "#333" : "#000", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: "monospace", transition: "all 0.2s" }}>
          {loading ? <Spinner/> : <Icon name="scan" size={14}/>}
          {loading ? progress || "Scanning…" : "Scan"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        {[["PEG ≤", "pegMax", 0.1], ["P/E ≤", "peMax", 1], ["EPS Grw ≥%", "epsGrowthMin", 1], ["Gross Mgn ≥%", "grossMarginMin", 1]].map(([label, key, step]) => (
          <div key={key}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
            <input type="number" step={step} value={filters[key]} onChange={e => setFilters(p => ({ ...p, [key]: parseFloat(e.target.value) }))}
              style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 6, color: "#d0d0d0", padding: "7px 11px", width: 90, fontSize: 13, fontFamily: "monospace" }}/>
          </div>
        ))}
      </div>
      {results.length > 0 && (
        <div style={{ background: "#070707", borderRadius: 12, border: "1px solid #181818", overflow: "hidden" }}>
          <div style={{ padding: "11px 20px", borderBottom: "1px solid #181818", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#3a3a3a", fontFamily: "monospace" }}>{filtered.length}/{results.length} match · snapshots → DB</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Badge color="#00e5a0">PEG &lt;0.8</Badge>
              <Badge color="#f5c842">0.8–1.5</Badge>
              <Badge color="#ff6b6b">&gt;1.5</Badge>
            </div>
          </div>
          <TableHeader/>
          {filtered.map(s => <StockRow key={s.symbol} stock={s} actions={[{ label: "Add to Shortlist", icon: "star", color: "#f5c842", fn: onAddToShortlist }]}/>)}
          {filtered.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#2a2a2a", fontFamily: "monospace" }}>No stocks match filters</div>}
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
    for (const p of positions) { const q = await fetchQuote(p.symbol); if (q) out[p.symbol] = q; }
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

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("scanner");
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
    { id: "scanner", label: "Scanner", icon: "scan" },
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
          <Icon name="db" size={10}/> Supabase · FMP Live
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
              </h1>
              <p style={{ color: "#2a2a2a", fontSize: 12, marginTop: 3 }}>
                {tab === "scanner" && "PEG-first scan · snapshots auto-saved on every scan"}
                {tab === "shortlist" && "Entry targets & thesis · persisted in Supabase"}
                {tab === "portfolio" && "Live P&L · positions synced to Supabase"}
                {tab === "peg" && "PEG over time · seed 120 days or build daily via scanner"}
              </p>
            </div>
            {tab === "scanner" && <ScannerTab onAddToShortlist={addToShortlist}/>}
            {tab === "shortlist" && <ShortlistTab shortlist={shortlist} setShortlist={setShortlist}/>}
            {tab === "portfolio" && <PortfolioTab positions={positions} setPositions={setPositions}/>}
            {tab === "peg" && <PEGChartTab portfolioSymbols={positions.map(p => p.symbol)}/>}
          </>
        )}
      </div>
    </div>
  );
}
