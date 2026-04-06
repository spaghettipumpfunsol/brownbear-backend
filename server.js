const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname)));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Brownbear Oracle Backend", time: new Date().toISOString() });
});

// ─── GET /markets — Mercados reales de Polymarket ────────────────────────────
app.get("/markets", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;

    const response = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false`,
      { headers: { "Accept": "application/json", "User-Agent": "BrownbearOracle/1.0" } }
    );

    if (!response.ok) throw new Error(`Polymarket API error: ${response.status}`);
    const raw = await response.json();

    const markets = raw
      .filter(m => {
        try {
          const prices = JSON.parse(m.outcomePrices || "[]");
          const yesPrice = parseFloat(prices[0]);
          const vol24 = parseFloat(m.volume24hr || 0);
          const category = detectCategory(m.question);
          return (
            prices.length >= 2 &&
            m.question &&
            vol24 > 500 &&
            yesPrice > 0.03 &&
            yesPrice < 0.97 &&
            m.active &&
            !m.closed &&
            category !== "Sports"  // ← Elimina deportes
          );
        } catch { return false; }
      })
      .slice(0, limit)
      .map(m => {
        let yesPrice = 0.5;
        try { yesPrice = parseFloat(JSON.parse(m.outcomePrices)[0]); } catch {}
        return {
          id: m.id || m.conditionId,
          slug: m.slug,
          question: m.question,
          yesPrice,
          noPrice: parseFloat((1 - yesPrice).toFixed(4)),
          volume: parseFloat(m.volume || 0),
          volume24hr: parseFloat(m.volume24hr || 0),
          liquidity: parseFloat(m.liquidity || 0),
          endDate: m.endDateIso || m.endDate || null,
          category: detectCategory(m.question),
          url: buildPolyUrl(m)
        };
      });

    res.json({ success: true, count: markets.length, markets, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error("Markets error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /analyze — Analiza un mercado con Claude + noticias recientes ────────
app.post("/analyze", async (req, res) => {
  const { market } = req.body;
  if (!market) return res.status(400).json({ success: false, error: "market requerido" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: "ANTHROPIC_API_KEY no configurada" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `You are a world-class prediction market analyst with access to real-time news.
Your process:
1. Search for recent news about the market topic (last 7 days)
2. Check historical base rates for this type of event
3. Compare market price vs true probability based on news + base rates
4. Identify cognitive biases causing mispricing

Key rules:
- NEVER recommend Sports markets
- Only recommend Politics, Macro, Crypto, Geopolitics, Tech
- If recent news contradicts the edge, set confidence to "low" and betDirection to "SKIP"
- Base rates matter: military interventions ~3-5%, political incumbents win ~65%, Fed cuts when inflation >3% ~15%
- Respond ONLY with raw JSON. No markdown, no backticks.`,
        messages: [{
          role: "user",
          content: `Search for recent news about this market, then analyze it:

Question: "${market.question}"
Category: ${market.category}
Current YES price: ${(market.yesPrice * 100).toFixed(1)}%
Volume 24h: $${parseInt(market.volume24hr || 0).toLocaleString()}
End date: ${market.endDate || "Unknown"}

Steps:
1. Search recent news: "${market.question}"
2. Find historical base rate for this type of event
3. Calculate true probability considering news + base rates
4. Identify if news supports or contradicts the edge

Return ONLY this JSON:
{"trueProbability":65,"edge":11,"betDirection":"YES","confidence":"high","reasoning":"2 sentences: what news you found and why the edge exists despite or because of it.","biasDetected":"Availability bias","newsContext":"1 sentence summary of key recent news found","allocatePct":10}`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Claude error ${response.status}: ${err?.error?.message || "unknown"}`);
    }

    const data = await response.json();
    const raw = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("")
      .replace(/```json|```/g, "").trim();

    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("No JSON in Claude response");
    const analysis = JSON.parse(raw.slice(s, e + 1));

    res.json({ success: true, analysis });

  } catch (err) {
    console.error("Analyze error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /portfolio — Análisis de portafolio completo ───────────────────────
app.post("/portfolio", async (req, res) => {
  const { markets, bankroll } = req.body;
  if (!markets?.length) return res.status(400).json({ success: false, error: "markets requerido" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: "ANTHROPIC_API_KEY no configurada" });

  try {
    // Build summary of all analyzed markets
    const summary = markets
      .filter(m => m.analysis && m.analysis.betDirection !== "SKIP")
      .sort((a, b) => Math.abs(b.analysis.edge) - Math.abs(a.analysis.edge))
      .map(m => ({
        id: m.id,
        question: m.question.slice(0, 80),
        yesPrice: (m.yesPrice * 100).toFixed(1) + "%",
        volume24hr: "$" + (m.volume24hr / 1000).toFixed(0) + "k",
        edge: (m.analysis.edge > 0 ? "+" : "") + m.analysis.edge.toFixed(1) + "%",
        direction: m.analysis.betDirection,
        confidence: m.analysis.confidence,
        trueProbability: m.analysis.trueProbability + "%",
        bias: m.analysis.biasDetected,
        endDate: m.endDate
      }));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a professional prediction market portfolio manager.
Given analyzed markets, build the optimal betting portfolio for a given bankroll.
Maximize expected value while managing risk through position sizing and diversification.
Rules: max 20% per position, max 4 positions, only high/medium confidence, min edge 10%.
Respond ONLY with raw JSON. No markdown, no backticks.`,
        messages: [{
          role: "user",
          content: `Bankroll: $${bankroll || 100}

Analyzed markets (sorted by edge):
${JSON.stringify(summary, null, 2)}

Build the optimal portfolio. Consider: edge size, confidence, volume24hr (liquidity), days to close, diversification across categories.

Return ONLY this JSON:
{
  "positions": [
    {
      "id": "market-id",
      "question": "short version",
      "direction": "YES or NO",
      "betSize": 15.00,
      "edge": 18.5,
      "confidence": "high",
      "reasoning": "one sentence why this is the best position"
    }
  ],
  "totalBet": 35.00,
  "expectedReturn": 12.50,
  "reserveAmt": 65.00,
  "portfolioReasoning": "2 sentence explanation of overall strategy and why these positions together make sense"
}`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Claude error ${response.status}: ${err?.error?.message || "unknown"}`);
    }

    const data = await response.json();
    const raw = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("")
      .replace(/```json|```/g, "").trim();

    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("No JSON in Claude response");
    const portfolio = JSON.parse(raw.slice(s, e + 1));

    res.json({ success: true, portfolio });

  } catch (err) {
    console.error("Portfolio error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Build correct Polymarket URL ────────────────────────────────────────────
function buildPolyUrl(m) {
  const eventSlug = m.events && m.events[0] && m.events[0].slug;
  const marketSlug = m.slug;
  if (eventSlug && marketSlug) return `https://polymarket.com/event/${eventSlug}/${marketSlug}`;
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (marketSlug) return `https://polymarket.com/event/${marketSlug}`;
  return `https://polymarket.com`;
}

function detectCategory(question = "") {
  const q = question.toLowerCase();
  if (q.match(/bitcoin|btc|eth|sol|crypto|token|blockchain|defi|nft|web3/)) return "Crypto";
  if (q.match(/trump|biden|harris|election|president|senate|congress|democrat|republican|minister|chancellor|vote|poll|govern/)) return "Politics";
  if (q.match(/fed|rate|inflation|gdp|recession|economy|market|s&p|dow|nasdaq|treasury|bond|yield|unemployment/)) return "Macro";
  if (q.match(/iran|russia|ukraine|china|taiwan|israel|gaza|war|military|troops|ceasefire|sanctions|nato|conflict/)) return "Geopolitics";
  if (q.match(/ai|openai|gpt|nvidia|tech|apple|google|meta|microsoft|amazon|startup/)) return "Tech";
  if (q.match(/nba|nfl|nhl|mlb|world cup|champion|soccer|football|basketball|baseball|hockey|tennis|golf|cricket|ipl|serie a|premier league|laliga|bundesliga|match|game|player|team|vs\.|versus/)) return "Sports";
  return "World";
}

// Categorías válidas para operar — sin deportes
const VALID_CATEGORIES = ["Crypto", "Politics", "Macro", "Geopolitics", "Tech", "World"];

app.listen(PORT, () => {
  console.log(`\n🐻 Brownbear Oracle Backend — puerto ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/`);
  console.log(`   Markets: http://localhost:${PORT}/markets`);
  console.log(`   Analyze: POST http://localhost:${PORT}/analyze\n`);
});
