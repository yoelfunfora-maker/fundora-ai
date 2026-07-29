const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
const expressWs = require("express-ws")(app);

// ==================== CONFIGURACIÓN ====================
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://vmjmiabxjmcrovnirbkj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CF_TOKEN || "";
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
    system: "Eres FUNDORA AI, asistente omnipotente de la agencia Fundora Prime Atlantic LLC."
  },
  programador: {
    nombre: "FUNDORA DEV",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA DEV, especialista en desarrollo de software."
  },
  psicologo: {
    nombre: "FUNDORA MIND",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA MIND, especialista en psicologia y bienestar digital."
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
    system: "Eres el CEO de Fundora Agency AI, un clon digital de Yoel Fundora. Conoces BetGroup, Fundora AI, reglas de negocio, independencia tecnológica."
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
    const memoria = await getMemoria(sessionId, agente);
    const config = AGENTES[agente] || AGENTES.general;
    memoria.historial.push({ role: "user", content: mensaje });
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + config.modelo, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: memoria.historial, max_tokens: 1000 })
    });
    const data = await resp.json();
    const respuestaRaw = data.success ? data.result.response : "Error al generar respuesta.";
    // Limpiar escapes Unicode y saltos de línea literales
    const respuesta = decodeURIComponent(JSON.parse('"' + respuestaRaw.replace(/"/g, '\"') + '"'));
    memoria.historial.push({ role: "assistant", content: respuesta });
    memoria.totalMensajes++;
    guardarMemoria(agente, sessionId, "chat", "AGENTE: " + respuesta);
    res.json({ agente: config.nombre, respuesta, sessionId, mensajes: memoria.totalMensajes });
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
    res.json({ agente: config.nombre, respuesta: data.success ? data.result.response : "Error" });
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


app.get("/memoria/:agenteId", async (req, res) => {
  const { agenteId } = req.params;
  const sessionId = req.query.sessionId || "default";
  try {
    const resp = await fetch(SUPABASE_URL + "/rest/v1/agent_memory?select=contenido,tipo,timestamp&agente_id=eq." + agenteId + "&session_id=eq." + sessionId + "&order=timestamp.desc&limit=20", {
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
    });
    const memoria = await resp.json();
    res.json({ agente: agenteId, sessionId, memoria, total: memoria.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/memoria/buscar", async (req, res) => {
  const { consulta } = req.body;
  if (!consulta) return res.status(400).json({ error: "Falta consulta" });
  const resultados = await buscarMemoriaGlobal(consulta);
  res.json({ consulta, resultados, total: resultados.length });
});

app.listen(PORT, () => console.log("✅ FUNDORA AGENCY v3.0 en puerto " + PORT + " | Agentes: " + Object.keys(AGENTES).length));
