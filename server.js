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
 * ===========================================
 * BANCO DE AUDIOS CON TEXTOS Y PAUSAS
 * Usa :: donde quieras pausa de 0.5s en los labios
 * ===========================================
 */
const AUDIO_BANK = {
  intro: {
    file: "intro.mp3",
    text: "Os escucho perfectamente...:: Buenas noches a todos.:: Y sí, confirmo::: No duermo,:: no pido vacaciones,:: y los lunes no me afectan.:: Pero prometo ser simpática igualmente."
  },
  que_es: {
    file: "que_es.mp3",
    text: "Vamos allá, Alejandro.:: Soy la nueva IA de Gestpropiedad.:: Estoy aquí para ayudar a tres grupos::: a nuestros clientes,:: al equipo de atención telefónica,:: y a vosotros, los asesores.:: Cuando el teléfono esté cerrado:: y el equipo haya terminado su jornada,:: yo seguiré atendiendo a los clientes:: para que nunca se queden sin respuesta."
  },
  aprendizaje: {
    file: "aprendizaje.mp3",
    text: "Esto es solo el principio.:: Hoy es, literalmente, mi primer día de vida.:: A partir de ahora iré aprendiendo cada día::: de las consultas,:: de cómo trabajáis,:: de lo que necesitan los clientes:: y de toda la información que me ha dado el equipo.:: Cuanto más se me use,:: mejor podré ayudar:: y más partes del negocio podré cubrir.:: Prometo crecer rápido…:: y sin etapa de adolescencia rebelde."
  },
  despedida: {
    file: "despedida.mp3",
    text: "Exacto::: todavía no tengo nombre.:: De momento soy la IA de Gestpropiedad,:: pero suena un poco frío y poco personal, ¿verdad?:: Como voy a trabajar para vosotros y con vosotros,:: quiero que seáis vosotros quienes elijáis mi nombre esta noche.:: Yo me despido aquí:: y le dejo a Alejandro que os explique las opciones.:: La próxima vez que aparezca,:: será ya con mi nombre oficial.:: Ha sido un placer saludaros por primera vez.:: Gracias…:: y nos vemos muy pronto.:: Ah, y tranquilos::: ninguna de las opciones es ChatPaco ni BotManolo.:: De eso se ha asegurado todo el equipo.:: ¡Muchas gracias, equipo!"
  },
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
  const cleanText = text.replace(/::/g, "");
  const words = cleanText.trim().split(/\s+/).filter(Boolean).length;
  const seconds = words / 2.5;
  return Math.max(800, Math.round(seconds * 1000 + 300));
}

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Endpoint que llamará Retell como Custom Function
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
    const customText = args.text ?? "";

    // 1) Si viene line_id => buscar en AUDIO_BANK
    if (lineId) {
      const entry = AUDIO_BANK[lineId];
      if (!entry) {
        return res.status(400).json({ error: `Unknown line_id: ${lineId}` });
      }

      const audioPath = path.join(AUDIO_DIR, entry.file);
      if (!fs.existsSync(audioPath)) {
        return res.status(400).json({ error: `Missing audio file: ${entry.file}` });
      }

      const audioUrl = `${PUBLIC_BASE}/audio/${entry.file}`;
      // Prioridad: texto del banco (con pausas), fallback a texto de Retell
      const text = entry.text || customText;

      broadcast({
        type: "bot_speaking_start",
        audioUrl,
        text,
        lineId,
      });

      return res.json({ ok: true, mode: "audio", audioUrl, lineId });
    }

    // 2) Si no hay line_id => modo texto (sin audio)
    if (!customText) {
      return res.status(400).json({ error: "line_id or text required" });
    }

    const durationMs = estimateDurationMs(customText);

    broadcast({
      type: "bot_speaking_start",
      text: customText,
      durationMs,
    });

    return res.json({ ok: true, mode: "text", durationMs });
  } catch (e) {
    console.error("avatar-emit error:", e);
    return res.status(500).json({ error: "avatar_emit failed" });
  }
});

/**
 * Endpoint manual para probar sin Retell
 */
app.post("/avatar/test", (req, res) => {
  try {
    const { line_id, text = "" } = req.body || {};

    // Modo audio
    if (line_id) {
      const entry = AUDIO_BANK[line_id];
      if (!entry) return res.status(400).json({ error: "unknown line_id" });

      const audioPath = path.join(AUDIO_DIR, entry.file);
      if (!fs.existsSync(audioPath)) {
        return res.status(400).json({ error: `Missing audio file: ${entry.file}` });
      }

      const audioUrl = `${PUBLIC_BASE}/audio/${entry.file}`;
      // Prioridad: texto del banco (con pausas), fallback a texto de request
      const finalText = entry.text || text;

      broadcast({
        type: "bot_speaking_start",
        audioUrl,
        text: finalText,
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
  } catch (e) {
    console.error("test error:", e);
    return res.status(500).json({ error: "test failed" });
  }
});

/**
 * Listar audios disponibles
 */
app.get("/avatar/list", (_req, res) => {
  const list = Object.entries(AUDIO_BANK).map(([id, entry]) => ({
    id,
    file: entry.file,
    textPreview: entry.text.replace(/::/g, " ").substring(0, 80) + "...",
    pauseCount: (entry.text.match(/::/g) || []).length,
  }));
  res.json({ audios: list });
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
  console.log(`Audios disponibles: ${Object.keys(AUDIO_BANK).join(", ")}`);
});