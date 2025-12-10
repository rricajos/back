import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import cors from "cors";
import { WebSocketServer } from "ws";
import { Retell } from "retell-sdk";

const app = express();

// CORS abierto para demo (puedes restringir al dominio del front en prod)
app.use(cors({ origin: "*" }));

// Captura raw body para firma (si tu SDK lo usa)
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3005;
const PUBLIC_BASE = process.env.PUBLIC_BASE || `http://localhost:${PORT}`;

const AUDIO_DIR = path.resolve("./audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Sirve estáticos de audio
app.use("/audio", express.static(AUDIO_DIR));

/**
 * Mapea line_id → archivo mp3
 * (Opcional, por si más adelante guardas audios por línea)
 */
const LINE_TO_FILE = {
  intro_1: "intro_1.mp3",
  intro_2: "intro_2.mp3",
  resolucion_1: "resolucion_1.mp3",
  cierre_1: "cierre_1.mp3",
};

// Broadcast WS al front
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Estimación simple de duración de habla
function estimateDurationMs(text = "") {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // ~2.5 palabras/seg (~150 wpm)
  const seconds = words / 2.5;
  // mínimo 800ms para no cortar animación
  return Math.max(800, Math.round(seconds * 1000 + 300));
}

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Endpoint que llamará Retell como Custom Function
 * Soporta:
 *  - args.line_id => modo audio (si existe archivo)
 *  - args.text => modo sin audio (tu caso actual)
 */
app.post("/retell/avatar-emit", (req, res) => {
  try {
    const signature = req.headers["x-retell-signature"];
    const verifyEnabled = (process.env.RETELL_VERIFY_SIGNATURE ?? "true") !== "false";

    if (
      verifyEnabled &&
      process.env.RETELL_API_KEY &&
      signature &&
      typeof Retell?.verify === "function"
    ) {
      const ok = Retell.verify(req.rawBody ?? "", process.env.RETELL_API_KEY, signature);
      if (!ok) return res.status(401).json({ error: "Invalid signature" });
    }


    const { args = {} } = req.body || {};
    const lineId = args.line_id ?? args.lineId;
    const text = args.text ?? "";

    // 1) Si viene line_id => intenta modo audio
    if (lineId) {
      const filename = LINE_TO_FILE[lineId];
      if (!filename) {
        return res.status(400).json({ error: `Unknown line_id: ${lineId}` });
      }

      const audioPath = path.join(AUDIO_DIR, filename);
      if (!fs.existsSync(audioPath)) {
        return res.status(400).json({ error: `Missing audio file: ${filename}` });
      }

      const audioUrl = `${PUBLIC_BASE}/audio/${filename}`;

      broadcast({
        type: "bot_speaking_start",
        audioUrl,
        text,
        lineId,
      });

      return res.json({ ok: true, mode: "audio", audioUrl });
    }

    // 2) Si no hay line_id => modo texto (sin audio)
    if (!text) {
      return res.status(400).json({ error: "line_id or text required" });
    }

    const durationMs = estimateDurationMs(text);

    broadcast({
      type: "bot_speaking_start",
      text,
      durationMs,
    });

    return res.json({ ok: true, mode: "text", durationMs });
  } catch (_e) {
    return res.status(500).json({ error: "avatar_emit failed" });
  }
});

/**
 * Endpoint manual para probar sin Retell
 * Body:
 *  - { line_id, text? }  -> modo audio si existe mp3
 *  - { text }            -> modo sin audio
 */
app.post("/avatar/test", (req, res) => {
  try {
    const { line_id, text = "" } = req.body || {};

    // Modo audio
    if (line_id) {
      const filename = LINE_TO_FILE[line_id];
      if (!filename) return res.status(400).json({ error: "unknown line_id" });

      const audioPath = path.join(AUDIO_DIR, filename);
      if (!fs.existsSync(audioPath)) {
        return res.status(400).json({ error: `Missing audio file: ${filename}` });
      }

      const audioUrl = `${PUBLIC_BASE}/audio/${filename}`;

      broadcast({
        type: "bot_speaking_start",
        audioUrl,
        text,
        lineId: line_id,
      });

      return res.json({ ok: true, mode: "audio", audioUrl });
    }

    // Modo texto
    if (!text) return res.status(400).json({ error: "text required" });

    const durationMs = estimateDurationMs(text);

    broadcast({
      type: "bot_speaking_start",
      text,
      durationMs,
    });

    return res.json({ ok: true, mode: "text", durationMs });
  } catch (_e) {
    return res.status(500).json({ error: "test failed" });
  }
});

/**
 * Forzar stop manual
 */
app.post("/avatar/stop", (_req, res) => {
  broadcast({ type: "bot_speaking_end" });
  res.json({ ok: true });
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", ts: Date.now() }));
});

server.listen(PORT, () => {
  console.log(`Avatar Bridge running on ${PUBLIC_BASE}`);
});
