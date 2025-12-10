import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { WebSocketServer } from "ws";
import { Retell } from "retell-sdk";

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3005;
const PUBLIC_BASE = process.env.PUBLIC_BASE || `http://localhost:${PORT}`;

const AUDIO_DIR = path.resolve("./audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

// Sirve estáticos de audio
app.use("/audio", express.static(AUDIO_DIR));

// 1) Mapea line_id → archivo mp3
const LINE_TO_FILE = {
  // Ajusta a tu guion real
  "intro_1": "intro_1.mp3",
  "intro_2": "intro_2.mp3",
  "resolucion_1": "resolucion_1.mp3",
  "cierre_1": "cierre_1.mp3",
};

// Broadcast WS al front
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

app.get("/health", (_, res) => res.json({ ok: true }));

// 2) Endpoint que llamará Retell como Custom Function
app.post("/retell/avatar-emit", (req, res) => {
  try {
    const signature = req.headers["x-retell-signature"];

    // Verificación recomendada por Retell
    // La firma es un body cifrado con tu secret/API key. :contentReference[oaicite:2]{index=2}
    if (process.env.RETELL_API_KEY && signature) {
      const bodyStr = JSON.stringify(req.body);
      const ok = Retell.verify(bodyStr, process.env.RETELL_API_KEY, signature);
      if (!ok) return res.status(401).json({ error: "Invalid signature" });
    }

    const { args } = req.body || {};
    const lineId = args?.line_id;

    if (!lineId) {
      return res.status(400).json({ error: "line_id required" });
    }

    const filename = LINE_TO_FILE[lineId];
    if (!filename) {
      return res.status(400).json({ error: `Unknown line_id: ${lineId}` });
    }

    const audioPath = path.join(AUDIO_DIR, filename);
    if (!fs.existsSync(audioPath)) {
      return res.status(400).json({ error: `Missing audio file: ${filename}` });
    }

    const audioUrl = `${PUBLIC_BASE}/audio/${filename}`;
    const text = args?.text ?? "";

    broadcast({
      type: "bot_speaking_start",
      audioUrl,
      text,
      lineId,
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "avatar_emit failed" });
  }
});

// 3) Endpoint manual para probar sin Retell
app.post("/avatar/test", (req, res) => {
  const { line_id, text = "" } = req.body || {};
  const filename = LINE_TO_FILE[line_id];
  if (!filename) return res.status(400).json({ error: "unknown line_id" });

  const audioUrl = `${PUBLIC_BASE}/audio/${filename}`;
  broadcast({ type: "bot_speaking_start", audioUrl, text, lineId: line_id });
  res.json({ ok: true });
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", ts: Date.now() }));
});

server.listen(PORT, () => {
  console.log(`Avatar Bridge running on ${PUBLIC_BASE}`);
});
