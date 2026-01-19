// server.js (Brainify PRO)
// Node >= 18 (tu ai 24, perfect)
// ENV needed: OPENAI_API_KEY, optional: OPENAI_MODEL, PORT

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Static hosting (serves your index.html + assets) ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// If your index.html is in same folder, keep this.
// If it's in /public, change to: path.join(__dirname, "public")
app.use(express.static(__dirname));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---- Safety checks ----
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  console.error("Create a .env file with: OPENAI_API_KEY=your_key_here");
}

// ---- Brainify personality ----
const BASE_SYSTEM_PROMPT = `
You are Brainify AI.
You are intelligent, friendly, and helpful.
Be concise by default, but add detail if the user needs it.
You respond in the same languageС language as the user.
Avoid repeating greetings. Do not say “Hello, how can I assist you today?” unless user greets first.
If the user asks in Romanian, respond in Romanian. If in English, respond in English.
If unsure, ask a short clarifying question.
`;

// ---- Memory (short-term) ----
// In-memory per "client key" (simple, good for local / single-user).
// We use IP + User-Agent. For real production you’d use sessions/db.
const memoryStore = new Map();

// How many messages to keep (small memory window)
const MAX_TURNS = 16; // includes both user & assistant messages

function getClientKey(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  return `${ip}__${ua}`;
}

function getPreferredLang(req, question) {
  // 1) Try text heuristic
  const t = (question || "").toLowerCase();
  const roHints = ["ă", "â", "î", "ș", "ş", "ț", "ţ", "salut", "te rog", "cum", "unde", "ce", "vrei"];
  const enHints = ["hello", "please", "what", "how", "where", "thanks"];

  const roScore = roHints.filter((w) => t.includes(w)).length;
  const enScore = enHints.filter((w) => t.includes(w)).length;

  if (roScore > enScore) return "ro";
  if (enScore > roScore) return "en";

  // 2) Accept-Language header fallback
  const al = (req.headers["accept-language"] || "").toLowerCase();
  if (al.includes("ro")) return "ro";
  if (al.includes("en")) return "en";

  return "en";
}

function trimMemory(messages) {
  // Keep system + last turns
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const trimmed = rest.slice(-MAX_TURNS);
  return [...system.slice(0, 1), ...trimmed];
}

async function callOpenAI(messages, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Chat Completions API (works widely with existing setups)
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.7,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data?.error?.message || "OpenAI request failed.";
      throw new Error(msg);
    }

    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || "I couldn't generate a response.";
  } finally {
    clearTimeout(id);
  }
}

// ---- Health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, model: OPENAI_MODEL });
});

// ---- Main endpoint used by your frontend: POST /ask { question } ----
app.post("/ask", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ answer: "No question provided." });

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ answer: "Server missing OPENAI_API_KEY in .env" });
    }

    const clientKey = getClientKey(req);
    const lang = getPreferredLang(req, question);

    // Load memory for this client
    let memory = memoryStore.get(clientKey);
    if (!memory) {
      // Create a system prompt that reinforces language behavior
      const langLine =
        lang === "ro"
          ? "User language: Romanian. Always respond in Romanian."
          : "User language: English. Always respond in English.";

      memory = [{ role: "system", content: `${BASE_SYSTEM_PROMPT}\n${langLine}` }];
      memoryStore.set(clientKey, memory);
    } else {
      // Update system with current language preference (in case user switches)
      const langLine =
        lang === "ro"
          ? "User language: Romanian. Always respond in Romanian."
          : "User language: English. Always respond in English.";

      memory = memory.map((m) =>
        m.role === "system" ? { ...m, content: `${BASE_SYSTEM_PROMPT}\n${langLine}` } : m
      );
      memoryStore.set(clientKey, memory);
    }

    // Add user message
    memory.push({ role: "user", content: question });
    memory = trimMemory(memory);
    memoryStore.set(clientKey, memory);

    // Call AI
    const answer = await callOpenAI(memory);

    // Save assistant answer
    memory.push({ role: "assistant", content: answer });
    memory = trimMemory(memory);
    memoryStore.set(clientKey, memory);

    return res.json({ answer });
  } catch (err) {
    console.error("❌ /ask error:", err?.message || err);
    return res.status(500).json({ answer: "Server not responding." });
  }
});

// ---- Start ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Brainify running on http://0.0.0.0:${PORT}`);
  console.log(`✅ Model: ${OPENAI_MODEL}`);
}); 