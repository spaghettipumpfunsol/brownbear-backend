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
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=volume&ascending=false`,
      { headers: { "Accept": "application/json", "User-Agent": "BrownbearOracle/1.0" } }
    );

    if (!response.ok) throw new Error(`Polymarket API error: ${response.status}`);
    const raw = await response.json();

    const markets = raw
      .filter(m => {
        try {
          const prices = JSON.parse(m.outcomePrices || "[]");
          const yesPrice = parseFloat(prices[0]);
          const vol = parseFloat(m.volume || 0);
          return (
            prices.length >= 2 &&
            m.question &&
            vol > 50000 &&          // mínimo $50k volumen real
            yesPrice > 0.05 &&      // no mercados casi cerrados
            yesPrice < 0.95 &&      // precio entre 5% y 95%
            m.active &&
            !m.closed
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
          liquidity: parseFloat(m.liquidity || 0),
          endDate: m.endDateIso || m.endDate || null,
          category: detectCategory(m.question),
          url: `https://polymarket.com/event/${m.slug || m.id}`
        };
      });

    res.json({ success: true, count: markets.length, markets, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error("Markets error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /analyze — Analiza un mercado con Claude ───────────────────────────
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
        max_tokens: 500,
        system: `You are a world-class prediction market analyst. Detect mispricings from cognitive biases.
Key insight: markets OVERVALUE dramatic outcomes and UNDERVALUE status quo.
Respond ONLY with a raw JSON object. No markdown, no backticks, no explanation.`,
        messages: [{
          role: "user",
          content: `Analyze this Polymarket prediction market:
Question: "${market.question}"
Current YES price: ${(market.yesPrice * 100).toFixed(1)}%
Volume: $${parseInt(market.volume || 0).toLocaleString()}
Liquidity: $${parseInt(market.liquidity || 0).toLocaleString()}
End date: ${market.endDate || "Unknown"}

Return ONLY this JSON object:
{"trueProbability":65,"edge":11,"betDirection":"YES","confidence":"high","reasoning":"Two sentence explanation of the mispricing and edge.","biasDetected":"Hype premium","allocatePct":10}`
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

// ─── Helper: detecta categoría del mercado ───────────────────────────────────
function detectCategory(question = "") {
  const q = question.toLowerCase();
  if (q.match(/bitcoin|btc|eth|sol|crypto|token|blockchain/)) return "Crypto";
  if (q.match(/trump|biden|election|president|senate|congress|democrat|republican/)) return "Politics";
  if (q.match(/fed|rate|inflation|gdp|recession|economy|market|s&p|dow/)) return "Macro";
  if (q.match(/nba|nfl|world cup|champion|soccer|football|basketball/)) return "Sports";
  if (q.match(/ai|openai|gpt|nvidia|tech|apple|google|meta/)) return "Tech";
  return "World";
}

app.listen(PORT, () => {
  console.log(`\n🐻 Brownbear Oracle Backend — puerto ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/`);
  console.log(`   Markets: http://localhost:${PORT}/markets`);
  console.log(`   Analyze: POST http://localhost:${PORT}/analyze\n`);
});
