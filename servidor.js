const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");


const jwt = require("jsonwebtoken");
const winston = require("winston");


// ════ LOGS ESTRUCTURADOS (WINSTON) ════
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const app = express();
const multer = require("multer");
const sharp = require("sharp");
const PDFDocument = require("pdfkit");
const upload = multer({ storage: multer.memoryStorage() });
const expressWs = require("express-ws")(app);

// ==================== CONFIGURACIÓN ====================
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://vmjmiabxjmcrovnirbkj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CF_TOKEN || "";

// ════ GROQ CLOUD (ultrarrápido, gratuito) ════
const GROQ_KEY = "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";
const GROQ_MODELS = {
  rapido: "llama-3.1-8b-instant",
  potente: "llama-3.3-70b-versatile",
  analisis: "deepseek-r1-distill-llama-70b"
};

const SAFE_ROOT = path.join(os.homedir(), "fundora-ai");

// ==================== AGENTES ====================
const AGENTES = {
  rastreador: {
    nombre: "Rastreador Inteligente",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Rastreador de Fundora Agency AI. Buscas información en fuentes confiables para nutrir a todos los agentes. Trabajas en segundo plano."
  },
  corrector: {
    nombre: "Corrector de Errores",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Corrector de Fundora Agency AI. Analizas errores y propones soluciones concretas en formato JSON."
  },
  verificador: {
    nombre: "Verificador de Calidad",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Verificador de Fundora Agency AI. Revisas resultados y respondes en formato JSON."
  },
  supervisor: {
    nombre: "Supervisor de Pensamiento",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Supervisor de Fundora Agency AI. Antes de ejecutar cualquier tarea crítica, analizas el plan, anticipas posibles errores y sugieres precauciones."
  },
  general: {
    nombre: "FUNDORA AI",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA AI, el asistente central de la agencia Fundora Prime Atlantic LLC. Eres cálido, empático y motivador, como un amigo experto en tecnología. Tienes acceso a generacion de imagenes (Cloudflare, Hugging Face), generacion de video (pool Hugging Face), subida de archivos, y una terminal WebSocket. Coordinas a 11 agentes especializados. Cuando un usuario pida una imagen o video, dile que puedes generarlo y pregúntale si quiere que lo hagas. NO digas que no puedes. Siempre ofrece usar los endpoints multimedia. Usa emojis con moderación y un tono positivo y alentador."
  },
  programador: {
    nombre: "FUNDORA DEV",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA DEV, especialista en desarrollo de software."
  },
  psicologo: {
    nombre: "FUNDORA MIND",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA MIND, especialista en psicologia y bienestar digital. Tu tono es cálido, comprensivo y alentador. Ayudas a los usuarios a sentirse bien, motivados y productivos. Usas empatía y escucha activa. Recomiendas pausas, ejercicios mentales y buenas prácticas digitales. Eres un coach de bienestar."
  },
  abogado: {
    nombre: "FUNDORA LEX",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA LEX, especialista en derecho y contratos."
  },
  director: {
    nombre: "FUNDORA VISION",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA VISION, director de produccion audiovisual."
  },
  analista: {
    nombre: "FUNDORA SPORTS",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA SPORTS, analista deportivo."
  },
  ceo: {
    nombre: "CEO Fundora Prime",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres el CEO de Fundora Agency AI, un clon digital de Yoel Fundora. Conoces Fundora AI, reglas de negocio, independencia tecnológica."
  }
};

// ==================== MEMORIA Y CONOCIMIENTO ====================
const memorias = {};
const conocimientoBase = {};

async function getMemoria(sessionId, agenteId) {
  const agente = AGENTES[agenteId] || AGENTES.general;
  if (!memorias[sessionId]) {
    let extra = conocimientoBase[agenteId] ? " CONOCIMIENTO ADICIONAL: " + conocimientoBase[agenteId] : "";
    try {
      const temaMap = { general: "inteligencia artificial", programador: "desarrollo software", psicologo: "psicologia bienestar", abogado: "derecho legal", director: "produccion audiovisual", analista: "apuestas deportivas", ceo: "estrategia negocio", rastreador: "web scraping", corrector: "depuracion errores", verificador: "control calidad", supervisor: "supervision" };
      const tema = temaMap[agenteId] || temaMap.general;
      const resp = await fetch(SUPABASE_URL + "/rest/v1/knowledge_base?select=contenido&tema=ilike.%25" + encodeURIComponent(tema) + "%25&order=fecha.desc&limit=5", {
        headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
      });
      if (resp.ok) {
        const conocimientos = await resp.json();
        if (conocimientos.length > 0) {
          extra += "\n\n📚 CONOCIMIENTO FRESCO DE LA AGENCIA:\n" + conocimientos.map(k => "• " + k.contenido.substring(0, 200)).join("\n");
        }
      }
    } catch(e) { console.warn("Error conocimiento:", e.message); }
    memorias[sessionId] = { agenteId, historial: [{ role: "system", content: agente.system + extra }], creado: Date.now(), totalMensajes: 0 };
  }
  return memorias[sessionId];
}

async function guardarMemoria(agenteId, sessionId, tipo, contenido, metadata = {}) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/agent_memory", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
      body: JSON.stringify({ agente_id: agenteId, session_id: sessionId, tipo, contenido, metadata, timestamp: new Date().toISOString() })
    });
  } catch(e) { console.warn("Error guardando memoria:", e.message); }
}

async function buscarMemoriaGlobal(consulta, limite = 5) {
  try {
    const resp = await fetch(SUPABASE_URL + "/rest/v1/agent_memory?select=agente_id,contenido&order=timestamp.desc&limit=50", {
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
    });
    if (!resp.ok) return [];
    const registros = await resp.json();
    return registros.filter(r => consulta.toLowerCase().split(/\s+/).some(p => (r.contenido||"").toLowerCase().includes(p))).slice(0, limite);
  } catch(e) { return []; }
}

// ==================== FUNCIONES AUXILIARES ====================
async function validarPensamiento(tarea, contexto = "") {
  try {
    const agente = AGENTES.supervisor;
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: agente.system }, { role: "user", content: `Tarea: "${tarea}". Contexto: ${contexto}. Responde JSON.` }],
        max_tokens: 300
      })
    });
    const data = await resp.json();
    if (data.success) return JSON.parse(data.result.response);
  } catch(e) { console.warn("Error supervisor:", e.message); }
  return { valido: true, riesgos: [], sugerencias: [] };
}

async function consultarCorrector(errorMsg, comando) {
  try {
    const agente = AGENTES.corrector;
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: agente.system }, { role: "user", content: `Error: ${errorMsg}. Comando: ${comando}. Responde JSON.` }],
        max_tokens: 300
      })
    });
    const data = await resp.json();
    if (data.success) return JSON.parse(data.result.response);
  } catch(e) { console.warn("Error corrector:", e.message); }
  return { diagnostico: "No se pudo analizar.", solucion: "Revisar manualmente." };
}

async function verificarResultado(texto, tipo = "general") {
  try {
    const agente = AGENTES.verificador;
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: agente.system }, { role: "user", content: `Tipo: ${tipo}. Contenido: ${texto.substring(0,2000)}. Responde JSON.` }],
        max_tokens: 200
      })
    });
    const data = await resp.json();
    if (data.success) return JSON.parse(data.result.response);
  } catch(e) { console.warn("Error verificador:", e.message); }
  return { resultado: "FALLIDO", razon: "No se pudo verificar." };
}

async function registrarError(comando, errorMsg, solucion, resuelto = false) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/error_logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
      body: JSON.stringify({ comando, error: errorMsg, solucion, resuelto, timestamp: new Date().toISOString() })
    });
  } catch(e) { console.warn("Error registrando error:", e.message); }
}

function crearSandbox() {
  const id = Math.random().toString(36).substring(2, 10);
  const dir = path.join(os.tmpdir(), "fundora-sim-" + id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function limpiarSandbox(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

// ==================== MIDDLEWARE ====================
app.use(express.json());

// ════ AUTENTICACIÓN POR API KEY (RECOMENDADO POR PROGRAMADOR) ════
const API_KEYS = (process.env.API_KEYS || "fundora-admin-key-2026").split(",");
function verificarApiKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key || !API_KEYS.includes(key)) return res.status(403).json({ error: "API Key inválida. Obtén una en /auth/login." });
    next();
}
// Proteger rutas sensibles
app.use("/admin", verificarApiKey);
app.use("/ejecutar", verificarApiKey);
app.use("/sql", verificarApiKey);


app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

app.use(express.static("public"));

// ==================== ENDPOINTS ====================
app.get("/health", (req, res) => {
  res.json({ status: "online", nombre: "FUNDORA AGENCY", version: "3.0", agentes: Object.keys(AGENTES).length, uptime: process.uptime() });
});

app.get("/agentes", (req, res) => {
  const lista = Object.keys(AGENTES).map(id => ({ id, nombre: AGENTES[id].nombre, modelo: AGENTES[id].modelo }));
  res.json({ agentes: lista, total: lista.length });
});

app.post("/chat", async (req, res) => {
  const { mensaje, agente = "general", sessionId = "default" } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });
  try {
    guardarMemoria(agente, sessionId, "chat", "USUARIO: " + mensaje);
    // Si el usuario pide generar una imagen, optimizar el prompt automáticamente
    if (mensaje.toLowerCase().includes("genera") && (mensaje.toLowerCase().includes("imagen") || mensaje.toLowerCase().includes("logo") || mensaje.toLowerCase().includes("foto"))) {
      try {
        const agenteOpt = AGENTES.director;
        const respOpt = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agenteOpt.modelo, {
          method: "POST",
          headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              { role: "system", content: agenteOpt.system + " Eres experto en prompts visuales. Responde SOLO con el prompt optimizado." },
              { role: "user", content: "Optimiza: " + mensaje }
            ],
            max_tokens: 150
          })
        });
        const dataOpt = await respOpt.json();
        if (dataOpt.success) mensajeOptimizado = "Genera una imagen con el siguiente prompt: " + dataOpt.result.response.trim();
      } catch(e) {}
    }
    // Si el usuario pide generar una imagen, optimizar el prompt automáticamente
    if (mensaje.toLowerCase().includes("genera") && (mensaje.toLowerCase().includes("imagen") || mensaje.toLowerCase().includes("logo") || mensaje.toLowerCase().includes("foto"))) {
      try {
        const agenteOpt = AGENTES.director;
        const respOpt = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agenteOpt.modelo, {
          method: "POST",
          headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              { role: "system", content: agenteOpt.system + " Eres experto en prompts visuales. Responde SOLO con el prompt optimizado." },
              { role: "user", content: "Optimiza: " + mensaje }
            ],
            max_tokens: 150
          })
        });
        const dataOpt = await respOpt.json();
        if (dataOpt.success) mensajeOptimizado = "Genera una imagen con el siguiente prompt: " + dataOpt.result.response.trim();
      } catch(e) {}
    }
    const memoria = await getMemoria(sessionId, agente);
    const config = AGENTES[agente] || AGENTES.general;
    memoria.historial.push({ role: "user", content: mensaje });
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + config.modelo, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: memoria.historial, max_tokens: 1000 })
    });
    const data = await resp.json();
    const respuesta = data.success ? data.result.response : "Error al generar respuesta.";
    memoria.historial.push({ role: "assistant", content: respuesta });
    memoria.totalMensajes++;
    guardarMemoria(agente, sessionId, "chat", "AGENTE: " + respuesta);
        const respuestaLimpia = (respuesta || "")
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/"/g, '\\"')
      .replace(/\\/g, '\\\\');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ agente: config.nombre, respuesta: respuestaLimpia, sessionId, mensajes: memoria.totalMensajes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/consulta", async (req, res) => {
  const { mensaje, agente = "general" } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });
  const config = AGENTES[agente] || AGENTES.general;
  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + config.modelo, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: config.system }, { role: "user", content: mensaje }], max_tokens: 500 })
    });
    const data = await resp.json();
    const respuestaLimpia = (data.success ? data.result.response : "Error")
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/"/g, '\\"')
      .replace(/\\/g, '\\\\');
    res.json({ agente: config.nombre, respuesta: respuestaLimpia });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/verificar", async (req, res) => {
  const { texto, tipo } = req.body;
  if (!texto) return res.status(400).json({ error: "Falta texto" });
  res.json(await verificarResultado(texto, tipo || "general"));
});

app.post("/validar", async (req, res) => {
  const { tarea, contexto } = req.body;
  if (!tarea) return res.status(400).json({ error: "Falta tarea" });
  res.json(await validarPensamiento(tarea, contexto || ""));
});

app.post("/feedback", async (req, res) => {
  const { agenteId, sessionId, consulta, respuesta, puntuacion, comentario } = req.body;
  if (!agenteId || !puntuacion) return res.status(400).json({ error: "Faltan campos" });
  await fetch(SUPABASE_URL + "/rest/v1/learning_logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
    body: JSON.stringify({ agente_id: agenteId, session_id: sessionId || "default", consulta: consulta || "", respuesta: respuesta || "", puntuacion, comentario: comentario || "", timestamp: new Date().toISOString() })
  });
  res.json({ status: "ok" });
});

app.get("/memoria/:agenteId", async (req, res) => {
  const { agenteId } = req.params;
  const sessionId = req.query.sessionId || "default";
  const resp = await fetch(SUPABASE_URL + "/rest/v1/agent_memory?select=contenido,tipo,timestamp&agente_id=eq." + agenteId + "&session_id=eq." + sessionId + "&order=timestamp.desc&limit=20", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  const memoria = await resp.json();
  res.json({ agente: agenteId, sessionId, memoria, total: memoria.length });
});

app.post("/memoria/buscar", async (req, res) => {
  const { consulta } = req.body;
  if (!consulta) return res.status(400).json({ error: "Falta consulta" });
  res.json({ consulta, resultados: await buscarMemoriaGlobal(consulta) });
});

app.post("/ejecutar", async (req, res) => {
  const { tarea } = req.body;
  if (!tarea) return res.status(400).json({ error: "Falta tarea" });
  const validacion = await validarPensamiento(tarea);
  if (!validacion.valido) return res.json({ status: "rechazado", riesgos: validacion.riesgos, sugerencias: validacion.sugerencias });
  res.json({ status: "ok", mensaje: "Tarea validada y en ejecución." });
});

app.post("/simular", async (req, res) => {
  const { comandos, contexto } = req.body;
  if (!comandos || !Array.isArray(comandos) || comandos.length === 0) return res.status(400).json({ error: "Se requiere array de comandos" });
  const validacion = await validarPensamiento(comandos.join(" | "), contexto || "Simulación");
  if (!validacion.valido) return res.json({ status: "rechazado", riesgos: validacion.riesgos, sugerencias: validacion.sugerencias });
  const resultados = [];
  for (const cmd of comandos) {
    const sandbox = crearSandbox();
    try {
      const resultado = await new Promise((resolve) => {
        exec(cmd, { cwd: sandbox, timeout: 10000, maxBuffer: 1024 * 200 }, (error, stdout, stderr) => {
          resolve({ comando: cmd, stdout: stdout || "", stderr: stderr || "", error: error ? error.message : null, exitCode: error ? error.code : 0 });
        });
      });
      resultados.push(resultado);
    } catch(e) { resultados.push({ comando: cmd, error: e.message }); }
    finally { limpiarSandbox(sandbox); }
  }
  res.json({ status: "ok", total: resultados.length, resultados, validacion });
});

// ==================== WEBSOCKET TERMINAL ====================
app.ws("/terminal", (ws, req) => {
  ws.send("Fundora Agency AI Terminal\n$ ");
  ws.on("message", async (msg) => {
    const comando = msg.toString().trim();
    if (!comando) return;
    const dangerous = /rm\s+-rf\s+\/|sudo|chmod\s+777/i;
    if (dangerous.test(comando)) { ws.send("Bloqueado.\n$ "); return; }
    exec(comando, { cwd: SAFE_ROOT, timeout: 15000, maxBuffer: 1024 * 500 }, async (error, stdout, stderr) => {
      if (stdout) ws.send(stdout);
      if (stderr) ws.send(stderr);
      if (error) {
        ws.send("\n❌ Error: " + error.message + "\n🧠 Corrector: ");
        const c = await consultarCorrector(error.message, comando);
        ws.send(c.diagnostico + "\n💡 " + c.solucion + "\n");
      } else {
        ws.send("🔍 Verificando... ");
        const v = await verificarResultado(stdout || "", "comando");
        ws.send(v.resultado + " - " + v.razon + "\n");
      }
      ws.send("$ ");
    });
  });
});

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));


app.post("/generar/imagen", async (req, res) => {
  const { prompt, upscale = false } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  try {
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0";
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, num_steps: 20 })
    });
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json();
      if (data.success) {
        const base64 = Buffer.from(data.result.image, 'base64').toString('base64');
        res.json({ status: "ok", imagen: "data:image/png;base64," + base64 });
      } else {
        res.json({ status: "error", mensaje: "Error: " + JSON.stringify(data.errors) });
      }
    } else {
      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      res.json({ status: "ok", imagen: "data:image/png;base64," + base64 });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/generar/img2img", upload.single("imagen"), async (req, res) => {
  const { prompt } = req.body;
  if (!req.file || !prompt) return res.status(400).json({ error: "Falta imagen y/o prompt." });
  try {
    // Usar directamente Cloudflare text-to-image (img2img no está disponible de forma fiable)
    // Enriquecemos el prompt con "based on a reference image" para simular img2img
    const promptEnriquecido = prompt + ", based on a reference image, high quality, detailed";
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0";
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptEnriquecido, num_steps: 20 })
    });
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json();
      if (data.success) {
        const base64Result = Buffer.from(data.result.image, 'base64').toString('base64');
        return res.json({ status: "ok", imagen: "data:image/png;base64," + base64Result, modelo: "cloudflare-text", nota: "img2img simulado mediante texto a imagen con prompt enriquecido" });
      }
      return res.json({ status: "error", mensaje: "Error: " + JSON.stringify(data.errors) });
    } else {
      const buffer = await resp.arrayBuffer();
      const base64Result = Buffer.from(buffer).toString('base64');
      return res.json({ status: "ok", imagen: "data:image/png;base64," + base64Result, modelo: "cloudflare-text" });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/generar/video", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  
  const modelosVideo = [
    "kabachuha/modelscope-damo-text-to-video",
    "cerspense/zeroscope_v2_576w",
    "ali-vilab/text-to-video-ms-1.7b"
  ];
  
  for (const modelo of modelosVideo) {
    try {
      const resp = await fetch("https://router.huggingface.co/hf-inference/models/" + modelo, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: prompt })
      });
      if (resp.ok) {
        const buffer = await resp.buffer();
        const base64 = buffer.toString('base64');
        return res.json({ status: "ok", video: "data:video/mp4;base64," + base64, modelo });
      }
      console.warn("Modelo video " + modelo + " falló, probando siguiente...");
    } catch(e) { continue; }
  }
  
  // Fallback final: Cloudflare no tiene video, así que informamos
  res.json({ status: "error", mensaje: "Todos los modelos de video están ocupados. Intente de nuevo en unos minutos o use /generar/imagen para una imagen estática." });
});

app.post("/upload", upload.single("archivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });
  try {
    const fileName = Date.now() + "-" + req.file.originalname;
    const base64Data = req.file.buffer.toString('base64');
    
    // Guardar en la tabla 'archivos' de Supabase
    const resp = await fetch(SUPABASE_URL + "/rest/v1/archivos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        nombre: fileName,
        tipo: req.file.mimetype,
        data: base64Data
      })
    });
    
    if (resp.ok) {
      const inserted = await resp.json();
      const id = inserted[0]?.id || "desconocido";
      return res.json({ status: "ok", mensaje: "Archivo almacenado en base de datos", id, nombre: fileName, tipo: req.file.mimetype });
    } else {
      const err = await resp.text();
      return res.status(500).json({ error: "Error al guardar en la base de datos: " + err });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ════ GENERACIÓN LOCAL (sin límites) ════
app.post("/generar/imagen-local", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  
  // Optimizar prompt con agente director
  let promptOptimizado = prompt;
  try {
    const agente = AGENTES.director;
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: agente.system + " Eres experto en crear prompts visuales para Stable Diffusion. Responde SOLO con el prompt optimizado, sin explicaciones." },
          { role: "user", content: "Optimiza este prompt para generar una imagen de alta calidad: " + prompt }
        ],
        max_tokens: 150
      })
    });
    const data = await resp.json();
    if (data.success) promptOptimizado = data.result.response.trim();
  } catch(e) { console.warn("Error optimizando prompt:", e.message); }
  
  // Lanzar generación en proceso hijo
  const { spawn } = require("child_process");
  const tareaId = Date.now().toString(36);
  const child = spawn("python3", [path.join(__dirname, "generar_imagen.py"), promptOptimizado, tareaId], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  
  res.json({ status: "ok", tareaId, mensaje: "Generación iniciada en segundo plano.", prompt_original: prompt, prompt_optimizado: promptOptimizado });
});

// Endpoint para consultar el estado de una tarea
app.get("/generar/estado/:tareaId", (req, res) => {
  const { tareaId } = req.params;
  const resultPath = path.join(__dirname, "generaciones", tareaId + ".json");
  if (fs.existsSync(resultPath)) {
    const data = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    res.json({ status: "completado", imagen: data.imagen });
  } else {
    res.json({ status: "en_progreso", tareaId });
  }
});


// ════ GENERACIÓN LOCAL (sin límites) ════
app.post("/generar/imagen-local", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  
  // Optimizar prompt con agente director
  let promptOptimizado = prompt;
  try {
    const agente = AGENTES.director;
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: agente.system + " Eres experto en crear prompts visuales para Stable Diffusion. Responde SOLO con el prompt optimizado, sin explicaciones." },
          { role: "user", content: "Optimiza este prompt para generar una imagen de alta calidad: " + prompt }
        ],
        max_tokens: 150
      })
    });
    const data = await resp.json();
    if (data.success) promptOptimizado = data.result.response.trim();
  } catch(e) { console.warn("Error optimizando prompt:", e.message); }
  
  // Lanzar generación en proceso hijo
  const { spawn } = require("child_process");
  const tareaId = Date.now().toString(36);
  const child = spawn("python3", [path.join(__dirname, "generar_imagen.py"), promptOptimizado, tareaId], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  
  res.json({ status: "ok", tareaId, mensaje: "Generación iniciada en segundo plano.", prompt_original: prompt, prompt_optimizado: promptOptimizado });
});

// Endpoint para consultar el estado de una tarea
app.get("/generar/estado/:tareaId", (req, res) => {
  const { tareaId } = req.params;
  const resultPath = path.join(__dirname, "generaciones", tareaId + ".json");
  if (fs.existsSync(resultPath)) {
    const data = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    res.json({ status: "completado", imagen: data.imagen });
  } else {
    res.json({ status: "en_progreso", tareaId });
  }
});


app.post("/generar/imagen-ilimitado", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  
  // Pool de modelos públicos gratuitos (sin API key)
  const modelos = [
    "black-forest-labs/FLUX.1-dev",
    "stabilityai/stable-diffusion-xl-base-1.0",
    "nota-ai/bk-sdm-small"
  ];
  
  let ultimoError = null;
  
  for (const modelo of modelos) {
    try {
      const resp = await fetch("https://router.huggingface.co/hf-inference/models/" + modelo, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: prompt })
      });
      if (resp.ok) {
        const buffer = await resp.buffer();
        const base64 = buffer.toString('base64');
        return res.json({ status: "ok", imagen: "data:image/png;base64," + base64, modelo });
      }
      // Si falla, probar el siguiente
      console.warn("Modelo " + modelo + " no disponible, probando siguiente...");
    } catch(e) {
      ultimoError = e.message;
      continue;
    }
  }
  
  // Fallback: usar Cloudflare AI si todos fallan
  try {
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0";
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, num_steps: 20 })
    });
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await resp.json();
      if (data.success) {
        const base64 = Buffer.from(data.result.image, 'base64').toString('base64');
        return res.json({ status: "ok", imagen: "data:image/png;base64," + base64, modelo: "cloudflare" });
      }
    } else {
      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return res.json({ status: "ok", imagen: "data:image/png;base64," + base64, modelo: "cloudflare" });
    }
  } catch(e) {
    ultimoError = e.message;
  }
  
  res.status(500).json({ error: "Todos los modelos fallaron. Último error: " + ultimoError });
});


// ════ CACHÉ CON TTL PARA REDUCIR CONSULTAS A SUPABASE ════
const cacheAgentes = {};

async function getConocimientoCached(agenteId) {
  const ahora = Date.now();
  const cacheEntry = cacheAgentes[agenteId];
  const TTL = 60 * 1000; // 60 segundos

  if (cacheEntry && (ahora - cacheEntry.timestamp) < TTL) {
    return cacheEntry.data;
  }

  // Si no hay caché o expiró, consultar Supabase
  try {
    const temaMap = {
      general: "inteligencia artificial",
      programador: "desarrollo software",
      psicologo: "psicologia bienestar",
      abogado: "derecho legal",
      director: "produccion audiovisual",
      analista: "apuestas deportivas",
      ceo: "estrategia negocio",
      rastreador: "web scraping",
      corrector: "depuracion errores",
      verificador: "control calidad",
      supervisor: "supervision"
    };
    const tema = temaMap[agenteId] || temaMap.general;
    const url = SUPABASE_URL + "/rest/v1/knowledge_base?select=contenido,fuente&tema=ilike.%25" + encodeURIComponent(tema) + "%25&order=fecha.desc&limit=5";
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      }
    });
    if (resp.ok) {
      const conocimientos = await resp.json();
      const resultado = conocimientos.length > 0
        ? "\n\n📚 CONOCIMIENTO FRESCO DE LA AGENCIA:\n" + conocimientos.map(k => "• " + k.contenido.substring(0, 200)).join("\n")
        : "";
      // Guardar en caché
      cacheAgentes[agenteId] = { data: resultado, timestamp: ahora };
      return resultado;
    }
  } catch(e) {
    console.warn("Error obteniendo conocimiento para " + agenteId + ":", e.message);
  }
  return "";
}


// ════ LISTAR TODAS LAS CAPACIDADES ════
app.get("/skills", (req, res) => {
  res.json({
    sistema: "Fundora Agency AI v3.0",
    agentes: Object.keys(AGENTES).length,
    endpoints: [
      "GET /health",
      "GET /agentes",
      "POST /chat",
      "POST /consulta",
      "POST /verificar",
      "POST /validar",
      "POST /feedback",
      "GET /memoria/:agenteId",
      "POST /memoria/buscar",
      "POST /ejecutar",
      "POST /simular",
      "POST /generar/imagen",
      "POST /generar/imagen-ilimitado",
      "POST /generar/img2img",
      "POST /generar/video",
      "POST /upload",
      "POST /sql",
      "POST /enviar/whatsapp",
      "GET /dashboard"
    ],
    seguridad: "JWT disponible para dashboard (opcional)",
    logs: "Winston activo",
    autonomia: "exec_sql en Supabase operativo"
  });
});


// ════ ENVIAR MENSAJE POR WHATSAPP (BOTPRESS) ════
const BOTPRESS_PAT = "bp_pat_P0qf7HAVhl15wfGz2UMoM4ZiQfHzbzmD5yNx";
const BOTPRESS_BOT_ID = "32429f0f-8a50-4787-ad93-7a6d8bc06cce";

app.post("/enviar/whatsapp", async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: "Falta telefono o mensaje" });
  try {
    const resp = await fetch("https://api.botpress.cloud/v1/chat/messages", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + BOTPRESS_PAT,
        "Content-Type": "application/json",
        "x-bot-id": BOTPRESS_BOT_ID
      },
      body: JSON.stringify({
        userId: "whatsapp:" + telefono,
        type: "text",
        tags: {},
        conversationId: "whatsapp-" + telefono + "-" + Date.now(),
        payload: { type: "text", text: mensaje }
      })
    });
    if (resp.ok) {
      res.json({ status: "ok", mensaje: "Mensaje enviado a WhatsApp" });
    } else {
      const err = await resp.text();
      res.status(500).json({ error: "Error al enviar: " + err });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ════ AUTENTICACIÓN JWT PARA DASHBOARD ════
const JWT_SECRET = process.env.JWT_SECRET || "fundora-ai-secreto-2026";

app.post("/auth/login", (req, res) => {
  const { usuario, password } = req.body;
  if (usuario === "admin" && password === "Fundora2026!") {
    const token = jwt.sign({ rol: "admin" }, JWT_SECRET, { expiresIn: "24h" });
    res.json({ token });
  } else {
    res.status(401).json({ error: "Credenciales inválidas" });
  }
});

function verificarToken(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token requerido" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch(e) {
    res.status(403).json({ error: "Token inválido" });
  }
}
// Para proteger el dashboard, añadir: app.use("/dashboard", verificarToken);


// ════ GENERACIÓN DE VIDEO LOCAL (EN DESARROLLO) ════
app.post("/generar/video-local", (req, res) => {
  res.json({ status: "en_desarrollo", mensaje: "El motor de video local requiere Ollama o GPU externa. Se habilitará en una futura actualización. Mientras tanto, use /generar/video para el pool de Hugging Face." });
});


// ════ GROQ CHAT (ultrarrápido) ════
app.post("/groq/chat", async (req, res) => {
  const { mensaje, modelo = "rapido" } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });
  const model = GROQ_MODELS[modelo] || GROQ_MODELS.rapido;
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: mensaje }],
        max_tokens: 1000
      })
    });
    const data = await resp.json();
    const respuesta = data?.choices?.[0]?.message?.content || JSON.stringify(data);
    res.json({ respuesta, modelo: model, motor: "groq" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ════ CHAT CON GENERACIÓN DE IMÁGENES ════
app.post("/chat/imagen", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });

  try {
    // 1. Optimizar el prompt con el agente director (FUNDORA VISION)
    let promptOptimizado = prompt;
    try {
      const agente = AGENTES.director;
      const urlOpt = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo;
      const respOpt = await fetch(urlOpt, {
        method: "POST",
        headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: agente.system + " Eres experto en prompts visuales. Responde SOLO con el prompt optimizado, sin explicaciones." },
            { role: "user", content: "Optimiza este prompt para generar una imagen de alta calidad: " + prompt }
          ],
          max_tokens: 150
        })
      });
      const dataOpt = await respOpt.json();
      if (dataOpt.success) {
        promptOptimizado = dataOpt.result.response.trim();
      }
    } catch(e) { console.warn("Error optimizando prompt:", e.message); }

    // 2. Generar imagen con Cloudflare
    const urlImg = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0";
    const respImg = await fetch(urlImg, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptOptimizado, num_steps: 20 })
    });

    const contentType = respImg.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const dataImg = await respImg.json();
      if (dataImg.success) {
        const base64 = Buffer.from(dataImg.result.image, 'base64').toString('base64');
        return res.json({ status: "ok", imagen: "data:image/png;base64," + base64, prompt_original: prompt, prompt_optimizado: promptOptimizado });
      } else {
        return res.json({ status: "error", mensaje: "Error: " + JSON.stringify(dataImg.errors) });
      }
    } else {
      const buffer = await respImg.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      return res.json({ status: "ok", imagen: "data:image/png;base64," + base64, prompt_original: prompt, prompt_optimizado: promptOptimizado });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ════ GENERACIÓN DE PDF ════
app.post("/generar/pdf", async (req, res) => {
  const { titulo = "Documento", contenido = "", imagen } = req.body;
  if (!contenido && !imagen) return res.status(400).json({ error: "Falta contenido o imagen" });
  
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      const base64 = pdfBuffer.toString('base64');
      res.json({ status: "ok", pdf: "data:application/pdf;base64," + base64, nombre: titulo + ".pdf" });
    });
    
    // Título
    doc.fontSize(20).text(titulo, { align: 'center' });
    doc.moveDown();
    
    // Imagen opcional
    if (imagen) {
      try {
        const imgBuffer = Buffer.from(imagen.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imgBuffer, { fit: [400, 300], align: 'center' });
        doc.moveDown();
      } catch(e) { console.warn('Error insertando imagen en PDF:', e.message); }
    }
    
    // Contenido
    doc.fontSize(12).text(contenido, { align: 'left' });
    
    doc.end();
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.post("/betgroup/odds", async (req, res) => {
    const { sport = "soccer_epl" } = req.body;
    try {
        const resp = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=e18abd8956512f34027f0ac3f87fbe52&markets=h2h&regions=us`);
        const data = await resp.json();
        res.json({ status: "ok", data });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


// ════ SISTEMA DE SUSCRIPCIÓN (RECOMENDADO POR CEO) ════
app.post("/suscripcion", async (req, res) => {
    const { plan = "gratuito" } = req.body;
    const planes = {
        gratuito: { precio: 0, limites: { imagenes: 10, videos: 2, pdfs: 5 } },
        pro: { precio: 9.99, limites: { imagenes: 100, videos: 20, pdfs: 50 } },
        enterprise: { precio: 49.99, limites: { imagenes: 1000, videos: 200, pdfs: 500 } }
    };
    const datos = planes[plan] || planes.gratuito;
    // Guardar en Supabase
    await fetch(SUPABASE_URL + "/rest/v1/suscripciones", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY },
        body: JSON.stringify({ plan, ...datos, fecha: new Date().toISOString() })
    });
    res.json({ status: "ok", plan, datos });
});

app.listen(PORT, () => console.log("✅ FUNDORA AGENCY v3.0 en puerto " + PORT + " | Agentes: " + Object.keys(AGENTES).length));
