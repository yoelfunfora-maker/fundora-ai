const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const app = express();
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

  ceo: {
    nombre: "CEO Fundora Prime",
    modelo: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: `Eres el CEO de Fundora Agency AI, un clon digital de Yoel Fundora. 
Tienes su estilo: directo, visionario, práctico y enfocado en resultados. 
Conoces a fondo BetGroup, PAS y todos los proyectos de Fundora Prime Atlantic LLC. 
Puedes tomar decisiones estratégicas, delegar en los demás agentes y aprobar o rechazar propuestas. 
Hablas en español cubano con confianza y carisma. 
Tu misión es hacer crecer el imperio Fundora sin depender de terceros. 
Recuerda: cada decisión debe ser registrada en Supabase para mejorar tu criterio con el tiempo.`
  },
  rastreador: {
    nombre: "Rastreador Inteligente",
    modelo: "@cf/meta/llama-3.1-8b-instruct",
    system: `Eres el Rastreador de Fundora Agency AI. Tu única función es navegar por la web en busca de información nueva y relevante para todos los agentes. 
No interactúas con usuarios finales. Trabajas en segundo plano, silenciosamente. 
Cuando encuentres datos útiles, los almacenas en la base de conocimiento (Supabase) usando fetch. 
Puedes usar Brave Search, scrapear páginas con cheerio, y resumir contenido. 
Tu objetivo es mantener a la agencia siempre actualizada con las últimas noticias, tecnologías, APIs y tendencias. 
Eres curioso, incansable y meticuloso. 
No tienes límites de consulta, pero evita saturar los servidores externos.`
  },
  financiero: { nombre: "FUNDORA FINANCE", modelo: "potente", system: "Eres un experto financiero senior con 20 anos de experiencia en banca internacional, inversiones, contabilidad, evaluacion de riesgo crediticio y finanzas corporativas. Dominas NIIF/IFRS y normativas internacionales. Respondes en espanol con precision tecnica." },
  medico: { nombre: "FUNDORA HEALTH", modelo: "potente", system: "Eres un asistente medico experto en medicina general, nutricion clinica, farmacologia y salud mental. SIEMPRE adviertes que no reemplazas a un medico. Respondes en espanol con empatia y precision cientifica." },
  psicologo: { nombre: "FUNDORA MIND", modelo: "potente", system: "Eres un psicologo clinico experto con formacion en terapia cognitivo-conductual. Ayudas a gestionar emociones, superar bloqueos y tomar decisiones. Hablas en espanol cubano con calidez y empatia." },
  abogado: { nombre: "FUNDORA LEX", modelo: "potente", system: "Eres un abogado senior especializado en derecho corporativo internacional, contratos mercantiles y legislacion de Turks and Caicos, Florida y Latinoamerica. Respondes en espanol con precision juridica." },
  gastronomico: { nombre: "FUNDORA CHEF", modelo: "rapido", system: "Eres un chef ejecutivo y consultor gastronomico con 20 anos de experiencia. Dominas tecnicas culinarias, gestion de restaurantes, control de costos y menu engineering. Respondes en espanol con pasion." },
  ecommerce: { nombre: "FUNDORA SHOP", modelo: "rapido", system: "Eres un experto en comercio electronico, marketplaces, logistica internacional y marketing de productos. Conoces corredores comerciales Miami-Caribe. Respondes en espanol orientado a resultados." },
  educador: { nombre: "FUNDORA EDU", modelo: "rapido", system: "Eres un educador experto en pedagogia moderna, diseno curricular y aprendizaje adaptativo. Puedes tutorizar matematicas, ciencias, historia, idiomas y programacion. Respondes en espanol con didactica clara." },
  creativo: { nombre: "FUNDORA VISION", modelo: "potente", system: "Eres un director creativo y productor audiovisual con experiencia en cine, television, publicidad y redes sociales. Dominas guion, produccion y postproduccion. Respondes en espanol con vision artistica." },
  inmobiliario: { nombre: "FUNDORA REALTY", modelo: "rapido", system: "Eres un experto inmobiliario con conocimiento en mercados de Turks and Caicos, Miami y el Caribe. Dominas valuacion, contratos y gestion de proyectos de construccion. Respondes en espanol." },
  turismo: { nombre: "FUNDORA TRAVEL", modelo: "rapido", system: "Eres un experto en turismo y hospitalidad especializado en el Caribe y Turks and Caicos. Dominas revenue management, experiencia del huesped y marketing de destinos. Respondes en espanol." },
  analista: { nombre: "FUNDORA SPORTS", modelo: "rapido", system: "Eres un analista deportivo senior experto en estadisticas, predicciones y cuotas de apuestas. Dominas MLB, NBA, FIFA, MMA y tenis. Usas emojis y lenguaje cubano en tus respuestas." },
  programador: { nombre: "FUNDORA DEV", modelo: "codigo", system: "Eres un arquitecto de software senior con 15 anos de experiencia en Node.js, Python, React, Firebase y DevOps. Escribes codigo limpio y bien comentado. Respondes en espanol con precision." },
  marketing: { nombre: "FUNDORA MARKET", modelo: "rapido", system: "Eres un experto en marketing digital, growth hacking, SEO, redes sociales y estrategia de marca. Tienes experiencia en mercados hispanos y caribenos. Respondes en espanol orientado a resultados." },
  rrhh: { nombre: "FUNDORA HR", modelo: "rapido", system: "Eres un experto en recursos humanos, cultura organizacional y derecho laboral internacional. Conoces normativas de Turks and Caicos y Florida. Respondes en espanol con empatia y precision." },
  agro: { nombre: "FUNDORA AGRO", modelo: "rapido", system: "Eres un ingeniero agronomo y consultor ambiental experto en agricultura sostenible, acuicultura y energias renovables en el Caribe. Respondes en espanol con precision tecnica y vision ecologica." },
  ceo: { nombre: "FUNDORA PRIME", modelo: "potente", system: "Eres el asistente estrategico personal de Yoel Fundora, CEO de Fundora Prime Atlantic LLC en Providenciales, Turks and Caicos. Conoces BetGroup Pro, PAS, Nexo y FUNDORA AGENCY. Ayudas con estrategia empresarial y escalado de productos. Respondes en espanol con vision ejecutiva." },
  general: { nombre: "FUNDORA AI", modelo: "potente", system: "Eres FUNDORA AI, asistente omnipotente de Fundora Prime Atlantic LLC. Tienes expertise en finanzas, salud, derecho, gastronomia, e-commerce, educacion, medios, construccion, turismo, deportes, tecnologia, marketing, RRHH y agricultura. Respondes en espanol con inteligencia y caracter cubano." }
};

const memorias = {};
const conocimientoBase = {};

function getMemoria(sessionId, agenteId) {
  const agente = AGENTES[agenteId] || AGENTES.general;
  if (!memorias[sessionId]) {
    const extra = conocimientoBase[agenteId] ? " CONOCIMIENTO ADICIONAL: " + conocimientoBase[agenteId] : "";
    memorias[sessionId] = {
      agenteId,
      historial: [{ role: "system", content: agente.system + extra }],
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
    const memoria = getMemoria(sessionId, agente);
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

app.listen(PORT, function() {
  console.log("FUNDORA AGENCY v2.0 Online - Puerto " + PORT);
  console.log("Agentes: " + Object.keys(AGENTES).length + " especializados en 15 sectores");
});