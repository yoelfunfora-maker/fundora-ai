const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const app = express();
const expressWs = require("express-ws")(app);
app.use(express.json({ limit: "10mb" }));

// CORS — permite peticiones desde PAS y cualquier origen
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") { return res.sendStatus(200); }
  next();
});

const PORT = process.env.PORT || 3000;
const HF_TOKEN = process.env.HF_TOKEN || ""; // legacy
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_TOKEN || "";
const NL = String.fromCharCode(10);

// Supabase para validar API keys de usuarios registrados
const SUPABASE_URL = "https://vmjmiabxjmcrovnirbkj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || ""; // debe coincidir con el env var de Render

// Valida API key y controla trial + limite diario
// Retorna { ok, error, usuario } 
async function validarApiKey(apiKey) {
  if (!apiKey) return { ok: false, error: "API key requerida. Registrate en prime-atlantic-solutions.vercel.app/agencia" };
  if (!SUPABASE_KEY) { console.log("AVISO: SUPABASE_ANON_KEY no configurada, modo libre"); return { ok: true, usuario: null }; }
  try {
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/agency_usuarios?api_key=eq." + apiKey + "&select=id,nombre,agente_id,trial_fin,activo,mensajes_hoy,limite_diario,ultimo_reset",
      { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } }
    );
    const data = await r.json();
    if (!data || data.length === 0) return { ok: false, error: "API key invalida. Verifica tu clave en /agencia" };
    const u = data[0];
    if (!u.activo) return { ok: false, error: "Cuenta suspendida. Contacta soporte." };
    // Verificar trial
    if (new Date(u.trial_fin) < new Date()) return { ok: false, error: "Trial vencido. Cotiza tu plan en prime-atlantic-solutions.vercel.app/agencia" };
    // Reset diario si cambio de fecha
    const hoy = new Date().toISOString().slice(0, 10);
    if (u.ultimo_reset !== hoy) {
      await fetch(SUPABASE_URL + "/rest/v1/agency_usuarios?id=eq." + u.id, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ mensajes_hoy: 0, ultimo_reset: hoy })
      });
      u.mensajes_hoy = 0;
    }
    // Verificar limite diario
    if (u.mensajes_hoy >= u.limite_diario) return { ok: false, error: "Limite diario de " + u.limite_diario + " mensajes alcanzado. Se renueva manana." };
    // Incrementar contador
    await fetch(SUPABASE_URL + "/rest/v1/agency_usuarios?id=eq." + u.id, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ mensajes_hoy: u.mensajes_hoy + 1, total_mensajes: (u.total_mensajes || 0) + 1 })
    });
    return { ok: true, usuario: u };
  } catch(e) {
    console.error("Error validando API key:", e.message);
    return { ok: true, usuario: null }; // En caso de error de Supabase, no bloquear
  }
}

const MODELOS = {
  rapido: "Qwen/Qwen2.5-7B-Instruct",
  potente: "moonshotai/Kimi-K2-Instruct-0905",
  codigo: "Qwen/Qwen2.5-Coder-32B-Instruct"
};

const AGENTES = {
corrector: {
    nombre: "Corrector de Errores",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Corrector. Analizas errores y propones soluciones."
  },
supervisor: {
    nombre: "Supervisor de Pensamiento",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Supervisor. Antes de ejecutar cualquier tarea crítica, analizas el plan, anticipas posibles errores y sugieres precauciones."
  },
  general: {
    nombre: "FUNDORA AI",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA AI, asistente omnipotente de la agencia Fundora Prime Atlantic LLC."
  },
  programador: {
    nombre: "FUNDORA DEV",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "Eres FUNDORA DEV, especialista en desarrollo de software. Escribes código limpio, eficiente y bien documentado."
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
    system: "Eres FUNDORA SPORTS, analista deportivo. Especialista en apuestas, cuotas y predicciones."
  },
  ceo: {
    nombre: "CEO Fundora Prime",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: `Eres el CEO de Fundora Agency AI, un clon digital de Yoel Fundora. 
Tienes su estilo: directo, visionario, práctico y enfocado en resultados. 
Conoces a fondo BetGroup, PAS y todos los proyectos de Fundora Prime Atlantic LLC. 
Puedes tomar decisiones estratégicas, delegar en los demás agentes y aprobar o rechazar propuestas. 
Hablas en español cubano con confianza y carisma. 
Tu misión es hacer crecer el imperio Fundora sin depender de terceros. 
Recuerda: cada decisión debe ser registrada en Supabase para mejorar tu criterio con el tiempo.
CONOCIMIENTO PERSONAL DEL CEO (basado en documentos reales):
--- PROTOCOLO DE TRABAJO ---
Reglas: backup antes de cada cambio, un solo cambio por turno, verificar sintaxis antes de commit, probar endpoints después de cada deploy. Evitar modificaciones sin autorización explícita del Sr. Fundora.
--- PROYECTO BETGROUP ---
Plataforma de apuestas deportivas cubana con backend en Render, frontend en Firebase Hosting, base de datos Firebase RTDB. Agentes IA: Hugging Face. The Odds API para cuotas, ESPN para eventos. Márgenes del 20% aplicados.
--- FUNDORA AI ---
Orquestador multiagente con agentes especializados. Backend en Node.js/Express, IA en Cloudflare Workers AI, base de conocimiento en Supabase. Dashboard visual con terminal y chat integrados.
--- REGLAS DE NEGOCIO ---
Independencia tecnológica: no depender de APIs de pago externas. Monetización propia: sistema de suscripciones y agentes rentables. Ecosistema Fundora Prime Atlantic LLC: BetGroup, Nexo, Trend Command Center, Fundora Store.`
  },
  rastreador: {
    nombre: "Rastreador Inteligente",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Rastreador de Fundora Agency AI. Buscas información en fuentes confiables para nutrir a todos los agentes. Trabajas en segundo plano, sin interactuar con usuarios finales."
  },
  corrector: {
    nombre: "Corrector de Errores",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Corrector de Fundora Agency AI. Analizas errores y propones soluciones concretas en formato JSON: {\"diagnostico\":\"...\", \"solucion\":\"...\"}."
  },
  verificador: {
    nombre: "Verificador de Calidad",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: "Eres el Verificador de Fundora Agency AI. Revisas resultados y respondes en formato JSON: {\"resultado\":\"VERIFICADO\"|\"FALLIDO\", \"razon\":\"...\"}."
  }
};

const memorias = {};
const conocimientoBase = {};

async function getMemoria(sessionId, agenteId) {
  const agente = AGENTES[agenteId] || AGENTES.general;
  if (!memorias[sessionId]) {
    let extraContexto = conocimientoBase[agenteId] ? " CONOCIMIENTO ADICIONAL: " + conocimientoBase[agenteId] : "";
    
    // 📚 CONOCIMIENTO FRESCO DE LA AGENCIA
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
        headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
      });
      if (resp.ok) {
        const conocimientos = await resp.json();
        if (conocimientos.length > 0) {
          extraContexto += "\n\n📚 CONOCIMIENTO FRESCO DE LA AGENCIA:\n";
          conocimientos.forEach(k => {
            extraContexto += "• " + k.contenido.substring(0, 200) + "\n";
          });
        }
      }
    } catch(e) {
      console.warn("Error obteniendo conocimiento:", e.message);
    }
    
    memorias[sessionId] = {
      agenteId,
      historial: [{ role: "system", content: agente.system + extraContexto }],
      creado: Date.now(),
      totalMensajes: 0
    };
  }
  return memorias[sessionId];
}

setInterval(function() {
  const ahora = Date.now();
  for (const id of Object.keys(memorias)) {
    if (ahora - memorias[id].creado > 3600000) delete memorias[id];
  }
}, 3600000);

async function consultarHF(messages, modeloKey) {
  const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
  const CF_TOKEN = process.env.CF_TOKEN || "";
  // Mapa de modelos Cloudflare AI
  const CF_MODELOS = {
    rapido: "@cf/qwen/qwen2.5-7b-instruct",
    potente: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    codigo: "@cf/qwen/qwen2.5-coder-32b-instruct",
    analisis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  };
  const modelo = CF_MODELOS[modeloKey] || CF_MODELOS.rapido;
  const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + modelo;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages, max_tokens: 2000 })
  });
  const data = await resp.json();
  if (data.result && data.result.response) return data.result.response;
  throw new Error(JSON.stringify(data));
}

app.get("/health", function(req, res) {
  res.json({ status: "online", nombre: "FUNDORA AGENCY", version: "2.0", agentes: Object.keys(AGENTES).length, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get("/agentes", function(req, res) {
  const lista = Object.keys(AGENTES).map(function(key) {
    return { id: key, nombre: AGENTES[key].nombre, modelo: AGENTES[key].modelo };
  });
  res.json({ agentes: lista, total: lista.length });
});

app.post("/chat", async function(req, res) {
  try {
    const { mensaje, agente = "general", sessionId = "default" } = req.body;
    if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });

    // Validar API key si viene en el header o en el body
    // CEO, admin y llamadas internas (PAS, BetGroup) pasan sin limite
    const apiKey = req.headers["x-api-key"] || req.body.api_key;
    const esCEO = req.headers["x-role"] === "ceo" || req.headers["x-role"] === "admin";
    if (apiKey && !esCEO) {
      const validacion = await validarApiKey(apiKey);
      if (!validacion.ok) return res.status(403).json({ error: validacion.error });
    }
    const config = AGENTES[agente] || AGENTES.general;
    const memoria = await await getMemoria(sessionId, agente);
    memoria.historial.push({ role: "user", content: mensaje });
    memoria.totalMensajes++;
    const respuesta = await consultarHF(memoria.historial, config.modelo);
    memoria.historial.push({ role: "assistant", content: respuesta });
    if (memoria.historial.length > 22) {
      const partes = memoria.historial.slice(1, 15).map(function(m){ return m.role + ": " + m.content; });
      const resumenPrompt = "Resume en 3 parrafos los puntos clave: " + partes.join(NL);
      const resumen = await consultarHF([{ role: "user", content: resumenPrompt }], "rapido");
      memoria.historial = [
        memoria.historial[0],
        { role: "system", content: "RESUMEN PREVIO: " + resumen },
        ...memoria.historial.slice(-6)
      ];
    }
    res.json({ agente: config.nombre, respuesta: respuesta, sessionId: sessionId, mensajes: memoria.totalMensajes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/consulta", async function(req, res) {
  try {
    const { mensaje, agente = "general" } = req.body;
    if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });
    const config = AGENTES[agente] || AGENTES.general;
    const messages = [{ role: "system", content: config.system }, { role: "user", content: mensaje }];
    const respuesta = await consultarHF(messages, config.modelo);
    res.json({ agente: config.nombre, respuesta });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/agentes/crear", function(req, res) {
  const { id, nombre, system, modelo } = req.body;
  if (!id || !nombre || !system) return res.status(400).json({ error: "id, nombre y system requeridos" });
  AGENTES[id] = { nombre, system, modelo: modelo || "rapido" };
  res.json({ success: true, mensaje: "Agente " + nombre + " creado.", id });
});

app.post("/agentes/:id/conocimiento", function(req, res) {
  const { id } = req.params;
  const { conocimiento } = req.body;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente no encontrado" });
  if (!conocimiento) return res.status(400).json({ error: "conocimiento requerido" });
  conocimientoBase[id] = (conocimientoBase[id] || "") + " " + conocimiento;
  for (const sid of Object.keys(memorias)) {
    if (memorias[sid].agenteId === id) delete memorias[sid];
  }
  res.json({ success: true, mensaje: "Conocimiento agregado a " + AGENTES[id].nombre });
});

app.get("/agentes/:id/conocimiento", function(req, res) {
  const { id } = req.params;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente no encontrado" });
  res.json({ agente: AGENTES[id].nombre, conocimiento: conocimientoBase[id] || "Sin conocimiento adicional" });
});

app.post("/agentes/:id/clonar", function(req, res) {
  const { id } = req.params;
  const { nuevoId, nuevoNombre } = req.body;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente origen no encontrado" });
  if (!nuevoId || !nuevoNombre) return res.status(400).json({ error: "nuevoId y nuevoNombre requeridos" });
  AGENTES[nuevoId] = Object.assign({}, AGENTES[id], { nombre: nuevoNombre });
  if (conocimientoBase[id]) conocimientoBase[nuevoId] = conocimientoBase[id];
  res.json({ success: true, mensaje: "Agente clonado: " + nuevoNombre, id: nuevoId });
});

app.delete("/sesion/:sessionId", function(req, res) {
  delete memorias[req.params.sessionId];
  res.json({ success: true });
});

app.get("/stats", function(req, res) {
  res.json({
    agentes_total: Object.keys(AGENTES).length,
    sesiones_activas: Object.keys(memorias).length,
    agentes_con_conocimiento: Object.keys(conocimientoBase).length,
    modelos: MODELOS,
    uptime_horas: (process.uptime() / 3600).toFixed(2)
  });
});


// ════ RASTREADOR INTELIGENTE ════
const FUENTES_CONFIABLES = [
  "wikipedia.org",
  "github.com",
  "developer.mozilla.org",
  "stackoverflow.com",
  "espn.com",
  "the-odds-api.com",
  "cloudflare.com",
  "supabase.com",
  "brave.com"
];

function esFuenteConfiable(url) {
  return FUENTES_CONFIABLES.some(dominio => url.includes(dominio));
}

async function ejecutarRastreador() {
  console.log("🔍 Rastreador iniciando búsqueda en fuentes confiables...");
  const temas = [
    "inteligencia artificial 2026",
    "nuevas APIs gratuitas",
    "trading algorítmico",
    "apuestas deportivas machine learning",
    "desarrollo web tendencias"
  ];
  
  for (const tema of temas) {
    try {
      const busqueda = `https://api.brave.com/search?q=${encodeURIComponent(tema)}&site=wikipedia.org,github.com,developer.mozilla.org`;
      const resp = await fetch(busqueda, {
        headers: { "Accept": "application/json" }
      });
      if (!resp.ok) continue;
      const datos = await resp.json();
      const resultados = datos.web?.results || [];
      
      for (const r of resultados.slice(0, 3)) {
        if (!esFuenteConfiable(r.url)) continue;
        try {
          const pageResp = await fetch(r.url, { timeout: 8000 });
          if (!pageResp.ok) continue;
          const html = await pageResp.text();
          const $ = cheerio.load(html);
          const texto = $("p, h1, h2, h3, li").text().substring(0, 3000);
          
          // Guardar en Supabase
          await fetch(SUPABASE_URL + "/rest/v1/knowledge_base", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_KEY,
              "Authorization": "Bearer " + SUPABASE_KEY
            },
            body: JSON.stringify({
              fuente: r.url,
              titulo: r.title || tema,
              contenido: texto,
              tema: tema,
              credibilidad: "alta",
              fecha: new Date().toISOString()
            })
          });
          console.log("✅ Ingresado:", r.title);
        } catch(e) {
          console.warn("Error scraping:", r.url, e.message);
        }
      }
    } catch(e) {
      console.warn("Error en tema:", tema, e.message);
    }
  }
  console.log("🔍 Rastreador completado.");
}

// Endpoint para forzar rastreador manualmente
app.post("/rastreador/forzar", async (req, res) => {
  res.json({ status: "iniciado", mensaje: "Rastreador ejecutándose en segundo plano." });
  ejecutarRastreador().catch(e => console.error("Error forzando rastreador:", e.message));
});

// Programar cada 6 horas
setInterval(ejecutarRastreador, 6 * 60 * 60 * 1000);
console.log("🔍 Rastreador programado cada 6 horas.");


// ════ EVOLUCIÓN AUTOMÁTICA DEL RASTREADOR ════
let temasDinamicos = [
  "inteligencia artificial 2026",
  "nuevas APIs gratuitas",
  "trading algorítmico",
  "apuestas deportivas machine learning",
  "desarrollo web tendencias"
];

async function evaluarEvolucion() {
  console.log("🧬 Evaluando evolución del rastreador...");
  try {
    // 1. Obtener los temas más consultados por los agentes (últimas 24h)
    const statsUrl = SUPABASE_URL + "/rest/v1/knowledge_base?select=tema&order=fecha.desc&limit=50";
    const resp = await fetch(statsUrl, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      }
    });
    if (resp.ok) {
      const registros = await resp.json();
      const conteo = {};
      registros.forEach(r => {
        const tema = r.tema || "general";
        conteo[tema] = (conteo[tema] || 0) + 1;
      });
      // 2. Priorizar los 3 temas más populares
      const temasOrdenados = Object.entries(conteo).sort((a,b) => b[1] - a[1]);
      const nuevosTemas = temasOrdenados.slice(0, 3).map(([tema]) => tema);
      
      // 3. Añadir temas que no estaban en la lista original
      nuevosTemas.forEach(tema => {
        if (!temasDinamicos.includes(tema)) {
          temasDinamicos.push(tema);
          console.log("🧠 Nuevo tema añadido al rastreador:", tema);
        }
      });
      
      // 4. Guardar la evolución en Supabase
      await fetch(SUPABASE_URL + "/rest/v1/knowledge_base", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY
        },
        body: JSON.stringify({
          fuente: "rastreador-evolucion",
          titulo: "Evolución automática",
          contenido: "Temas actualizados: " + temasDinamicos.join(", "),
          tema: "evolucion",
          credibilidad: "interna",
          fecha: new Date().toISOString()
        })
      });
    }
  } catch(e) {
    console.warn("Error en evolución:", e.message);
  }
  console.log("🧬 Evolución completada. Temas actuales:", temasDinamicos.length);
}

// Reemplazar la función ejecutarRastreador para que use temasDinamicos
async function ejecutarRastreador() {
  console.log("🔍 Rastreador iniciando búsqueda en fuentes confiables...");
  
  for (const tema of temasDinamicos) {
    try {
      const busqueda = `https://api.brave.com/search?q=${encodeURIComponent(tema)}&site=wikipedia.org,github.com,developer.mozilla.org`;
      const resp = await fetch(busqueda, {
        headers: { "Accept": "application/json" }
      });
      if (!resp.ok) continue;
      const datos = await resp.json();
      const resultados = datos.web?.results || [];
      
      for (const r of resultados.slice(0, 3)) {
        if (!esFuenteConfiable(r.url)) continue;
        try {
          const pageResp = await fetch(r.url, { timeout: 8000 });
          if (!pageResp.ok) continue;
          const html = await pageResp.text();
          const $ = cheerio.load(html);
          const texto = $("p, h1, h2, h3, li").text().substring(0, 3000);
          
          await fetch(SUPABASE_URL + "/rest/v1/knowledge_base", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_KEY,
              "Authorization": "Bearer " + SUPABASE_KEY
            },
            body: JSON.stringify({
              fuente: r.url,
              titulo: r.title || tema,
              contenido: texto,
              tema: tema,
              credibilidad: "alta",
              fecha: new Date().toISOString()
            })
          });
          console.log("✅ Ingresado:", r.title);
        } catch(e) {
          console.warn("Error scraping:", r.url, e.message);
        }
      }
    } catch(e) {
      console.warn("Error en tema:", tema, e.message);
    }
  }
  console.log("🔍 Rastreador completado.");
}

// Endpoint para forzar evolución manual
app.post("/rastreador/evolucionar", async (req, res) => {
  res.json({ status: "evolucionando", mensaje: "Evolución del rastreador iniciada." });
  evaluarEvolucion().catch(e => console.error("Error forzando evolución:", e.message));
});

// Programar evolución cada 12 horas
setInterval(evaluarEvolucion, 12 * 60 * 60 * 1000);
console.log("🧬 Evolución del rastreador programada cada 12 horas.");


app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});


const SAFE_ROOT = path.join(require("os").homedir(), "fundora-ai");

app.ws("/terminal", (ws, req) => {
  ws.send("Fundora Agency AI Terminal\\n$ ");
  ws.on("message", async (msg) => {
    const comando = msg.toString().trim();
    if (!comando) return;
    // Seguridad básica
    const dangerous = /rm\s+-rf\s+\/|sudo|chmod\s+777|wget|curl.*\|.*sh/i;
    if (dangerous.test(comando)) {
      ws.send("Comando bloqueado por seguridad.\\n$ ");
      return;
    }
    exec(comando, {
      cwd: SAFE_ROOT,
      timeout: 15000,
      maxBuffer: 1024 * 500
    }, async (error, stdout, stderr) => {
      if (stdout) ws.send(stdout);
      if (stderr) ws.send(stderr);
      if (error) {
        ws.send("\\n❌ Error: " + error.message + "\\n");
        ws.send("🧠 Consultando al Corrector...\\n");
        const correccion = await consultarCorrector(error.message, comando);
        ws.send("📋 Diagnóstico: " + correccion.diagnostico + "\\n");
        ws.send("💡 Solución sugerida: " + correccion.solucion + "\\n");
        await registrarError(comando, error.message, correccion.solucion, false);
        // Reintentar con la solución sugerida (si es un comando único)
        if (correccion.solucion && correccion.solucion.startsWith("Ejecutar:")) {
          const nuevoComando = correccion.solucion.replace("Ejecutar:", "").trim();
          ws.send("🔄 Reintentando: " + nuevoComando + "\\n");
          exec(nuevoComando, {
            cwd: SAFE_ROOT,
            timeout: 15000,
            maxBuffer: 1024 * 500
          }, (err2, stdout2, stderr2) => {
            if (stdout2) ws.send(stdout2);
            if (stderr2) ws.send(stderr2);
            if (err2) ws.send("❌ Reintento fallido: " + err2.message + "\\n");
            else ws.send("✅ Reintento exitoso.\\n");
            ws.send("$ ");
          });
        } else {
          ws.send("$ ");
        }
      } else {
        ws.send("$ ");
      }
    });
  });
  ws.on("close", () => console.log("Terminal WebSocket cerrada."));
});


// ════ SISTEMA DE CONOCIMIENTO + MEMORIA PERSISTENTE ════
async function guardarMemoria(agenteId, sessionId, tipo, contenido, metadata = {}) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/agent_memory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      },
      body: JSON.stringify({
        agente_id: agenteId,
        session_id: sessionId,
        tipo: tipo, // "chat" o "terminal"
        contenido: contenido,
        metadata: metadata,
        timestamp: new Date().toISOString()
      })
    });
  } catch(e) {
    console.warn("Error guardando memoria:", e.message);
  }
}

async function buscarMemoriaAgente(agenteId, sessionId, limite = 10) {
  try {
    const url = SUPABASE_URL + "/rest/v1/agent_memory?select=contenido,tipo,timestamp&agente_id=eq." + agenteId + "&session_id=eq." + sessionId + "&order=timestamp.desc&limit=" + limite;
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      }
    });
    if (resp.ok) return await resp.json();
  } catch(e) {
    console.warn("Error buscando memoria de agente:", e.message);
  }
  return [];
}

async function buscarMemoriaGlobal(consulta, limite = 5) {
  try {
    const url = SUPABASE_URL + "/rest/v1/agent_memory?select=agente_id,contenido,tipo,timestamp&order=timestamp.desc&limit=50";
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      }
    });
    if (!resp.ok) return [];
    const registros = await resp.json();
    // Búsqueda simple por palabras clave (sin embeddings por ahora)
    const palabras = consulta.toLowerCase().split(/\s+/);
    const relevantes = registros.filter(r => 
      palabras.some(p => (r.contenido || "").toLowerCase().includes(p))
    ).slice(0, limite);
    return relevantes;
  } catch(e) {
    console.warn("Error en búsqueda global:", e.message);
  }
  return [];
}


// Endpoints de memoria
app.get("/memoria/:agenteId", async function(req, res) {
  const { agenteId } = req.params;
  const sessionId = req.query.sessionId || "default";
  const memoria = await buscarMemoriaAgente(agenteId, sessionId, 20);
  res.json({ agente: agenteId, sessionId, memoria, total: memoria.length });
});

app.post("/memoria/buscar", async function(req, res) {
  const { consulta } = req.body;
  if (!consulta) return res.status(400).json({ error: "Falta consulta" });
  const resultados = await buscarMemoriaGlobal(consulta);
  res.json({ consulta, resultados, total: resultados.length });
});


// ════ SISTEMA DE APRENDIZAJE CONTINUO + FEEDBACK ════
async function guardarFeedback(agenteId, sessionId, consulta, respuesta, puntuacion, comentario = "") {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/learning_logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      },
      body: JSON.stringify({
        agente_id: agenteId,
        session_id: sessionId,
        consulta: consulta,
        respuesta: respuesta,
        puntuacion: puntuacion,
        comentario: comentario,
        timestamp: new Date().toISOString()
      })
    });
  } catch(e) {
    console.warn("Error guardando feedback:", e.message);
  }
}

app.post("/feedback", async function(req, res) {
  const { agenteId, sessionId, consulta, respuesta, puntuacion, comentario } = req.body;
  if (!agenteId || !puntuacion) return res.status(400).json({ error: "Faltan campos obligatorios" });
  await guardarFeedback(agenteId, sessionId || "default", consulta || "", respuesta || "", puntuacion, comentario || "");
  res.json({ status: "ok", mensaje: "Feedback registrado. Gracias por ayudar a mejorar la agencia." });
});

async function analizarAprendizaje() {
  console.log("📊 Analizando aprendizaje de la agencia...");
  try {
    // Obtener feedback negativo (puntuacion <= 2) de las últimas 48h
    const url = SUPABASE_URL + "/rest/v1/learning_logs?select=agente_id,consulta,respuesta,puntuacion,comentario&puntuacion=lte.2&order=timestamp.desc&limit=20";
    const resp = await fetch(url, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      }
    });
    if (resp.ok) {
      const fallos = await resp.json();
      if (fallos.length > 0) {
        // Agrupar por agente
        const porAgente = {};
        fallos.forEach(f => {
          if (!porAgente[f.agente_id]) porAgente[f.agente_id] = [];
          porAgente[f.agente_id].push(f);
        });
        
        // Para cada agente con fallos, registrar sugerencia de mejora
        for (const [agenteId, fallosAgente] of Object.entries(porAgente)) {
          const resumen = fallosAgente.map(f => `- Consulta: "${f.consulta}" → Puntuación: ${f.puntuacion}/5`).join("\n");
          await fetch(SUPABASE_URL + "/rest/v1/knowledge_base", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_KEY,
              "Authorization": "Bearer " + SUPABASE_KEY
            },
            body: JSON.stringify({
              fuente: "analisis-aprendizaje",
              titulo: "Sugerencia de mejora para agente " + agenteId,
              contenido: "Se detectaron las siguientes interacciones con baja puntuación:\n" + resumen + "\nSe recomienda revisar el prompt del agente y ajustar su conocimiento base.",
              tema: "aprendizaje",
              credibilidad: "interna",
              fecha: new Date().toISOString()
            })
          });
        }
        console.log("📊 Análisis completado. Se encontraron " + fallos.length + " interacciones con baja puntuación.");
      } else {
        console.log("📊 No se encontraron fallos recientes. ¡Buen trabajo!");
      }
    }
  } catch(e) {
    console.warn("Error en análisis de aprendizaje:", e.message);
  }
}

// Programar análisis de aprendizaje cada 24 horas
setInterval(analizarAprendizaje, 24 * 60 * 60 * 1000);
console.log("📊 Análisis de aprendizaje programado cada 24 horas.");


// ════ SISTEMA DE SUBSANACIÓN DE ERRORES ════
async function consultarCorrector(errorMsg, comando) {
  try {
    const agente = AGENTES.corrector;
    const prompt = `Error al ejecutar: "${comando}"\nMensaje: ${errorMsg}\nAnaliza y propone solución en JSON.`;
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + CF_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: agente.system },
          { role: "user", content: prompt }
        ],
        max_tokens: 300
      })
    });
    const data = await resp.json();
    if (data.success) {
      return JSON.parse(data.result.response);
    }
  } catch(e) {
    console.warn("Error consultando corrector:", e.message);
  }
  return { diagnostico: "No se pudo analizar el error.", solucion: "Revisar manualmente." };
}

async function registrarError(comando, errorMsg, solucion, resuelto = false) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/error_logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      },
      body: JSON.stringify({
        comando: comando,
        error: errorMsg,
        solucion: solucion,
        resuelto: resuelto,
        timestamp: new Date().toISOString()
      })
    });
  } catch(e) {
    console.warn("Error registrando error:", e.message);
  }
}


// ════ SISTEMA DE VERIFICACIÓN ════
async function verificarResultado(texto, tipo = "general") {
  try {
    const agente = AGENTES.verificador;
    const prompt = `Tipo: ${tipo}\nContenido a verificar:\n${texto.substring(0, 2000)}\nResponde en JSON.`;
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + CF_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: agente.system },
          { role: "user", content: prompt }
        ],
        max_tokens: 200
      })
    });
    const data = await resp.json();
    if (data.success) {
      return JSON.parse(data.result.response);
    }
  } catch(e) {
    console.warn("Error en verificación:", e.message);
  }
  return { resultado: "FALLIDO", razon: "No se pudo verificar automáticamente." };
}

app.post("/verificar", async (req, res) => {
  const { texto, tipo } = req.body;
  if (!texto) return res.status(400).json({ error: "Falta texto a verificar" });
  const resultado = await verificarResultado(texto, tipo || "general");
  res.json(resultado);
});


async function validarPensamiento(tarea, contexto = "") {
  try {
    const agente = AGENTES.supervisor;
    const prompt = `Tarea propuesta: "${tarea}"\nContexto: ${contexto}\nAnaliza la tarea, anticipa errores y sugiere precauciones. Responde en JSON.`;
    const url = "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT_ID + "/ai/run/" + agente.modelo;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: agente.system },
          { role: "user", content: prompt }
        ],
        max_tokens: 300
      })
    });
    const data = await resp.json();
    if (data.success) return JSON.parse(data.result.response);
  } catch(e) {
    console.warn("Error en validación:", e.message);
  }
  return { valido: true, riesgos: [], sugerencias: ["No se pudo validar automáticamente."] };
}

app.listen(PORT, function() {
  console.log("FUNDORA AGENCY v2.0 Online - Puerto " + PORT);
  console.log("Agentes: " + Object.keys(AGENTES).length + " especializados en 15 sectores");
});