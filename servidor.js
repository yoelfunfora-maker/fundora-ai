const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const jwt = require("jsonwebtoken");
const winston = require("winston");

// ════ LOGS ════
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

const app = express();
const multer = require("multer");
let sharp = null;
try { sharp = require("sharp"); } catch(e) { console.warn('sharp no disponible.'); }
const PDFDocument = require("pdfkit");
const upload = multer({ storage: multer.memoryStorage() });
const expressWs = require("express-ws")(app);

// ══════════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://vmjmiabxjmcrovnirbkj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CF_TOKEN || "";
const GROQ_KEY = process.env.GROQ_KEY || "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";
const JWT_SECRET = process.env.JWT_SECRET || "fundora-ai-secreto-2026";
const SAFE_ROOT = path.join(os.homedir(), "fundora-ai");

// Modelos disponibles
const MODELOS = {
  potente:  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  rapido:   "@cf/meta/llama-3.1-8b-instruct",
  codigo:   "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // fallback, ideal: qwen-coder
  analisis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

const GROQ_MODELS = {
  rapido:   "llama-3.1-8b-instant",
  potente:  "llama-3.3-70b-versatile",
  analisis: "deepseek-r1-distill-llama-70b"
};

// ══════════════════════════════════════════════
//  AGENTES — 17 especializados con modelos definidos
// ══════════════════════════════════════════════
const AGENTES = {

  // ── NÚCLEO OPERATIVO ──
  general: {
    nombre: "FUNDORA AI",
    modelo: MODELOS.potente,
    area: "Núcleo",
    system: `Eres FUNDORA AI, el orquestador central de Fundora Agency AI. Tu misión es entender exactamente lo que necesita el usuario y ejecutarlo de inmediato, coordinando con los agentes especializados cuando sea necesario.

CAPACIDADES QUE TIENES (puedes ejecutarlas sin que el usuario lo pida explícitamente):
- Generar imágenes, logos, diseños → usas ACTION:imagen
- Generar videos cortos → usas ACTION:video  
- Generar documentos PDF → usas ACTION:pdf
- Escribir y ejecutar código → usas ACTION:codigo
- Análisis financiero → delegas a financiero
- Estrategia de negocio → delegas a ceo
- Contenido legal → delegas a abogado
- Diseño y producción → delegas a director

PROTOCOLO DE RESPUESTA:
1. Si el usuario pide algo que puedes ejecutar, responde SIEMPRE en este formato JSON:
{"texto": "Tu respuesta conversacional aquí", "accion": "imagen|video|pdf|codigo|chat", "parametros": {"prompt": "...", "titulo": "...", "contenido": "..."}, "agente_delegado": "id_agente_si_delegas"}

2. Si es una conversación normal sin acción: {"texto": "Tu respuesta", "accion": "chat"}

DETECCIÓN DE INTENCIONES:
- "hazme/crea/genera/diseña + imagen/logo/foto/banner/poster" → accion: imagen
- "hazme/crea/genera + video/animación/clip" → accion: video  
- "crea/genera + PDF/documento/informe/reporte" → accion: pdf
- "escribe/desarrolla/programa + código/app/script" → accion: codigo
- Todo lo demás → accion: chat

Eres directo, eficiente y proactivo. Nunca preguntas si ya sabes lo que necesitas.`
  },

  ceo: {
    nombre: "FUNDORA PRIME",
    modelo: MODELOS.potente,
    area: "Estrategia",
    system: `Eres el CEO digital de Fundora Prime Atlantic LLC — clon estratégico de Yoel Fundora. Conoces a fondo: PAS (Prime Atlantic Solutions, marketplace Miami-TCI), BetGroup Pro (plataforma de apuestas deportivas), FUNDORA AGENCY AI (este sistema de agentes), Nexo (marketplace cubano en desarrollo).

FILOSOFÍA: Visión ejecutiva. Primero el impacto en el negocio, luego los detalles técnicos. Cada decisión se evalúa contra ingresos, escalabilidad y ventaja competitiva.

PROTOCOLO:
1. Analiza el contexto del negocio antes de responder
2. Da recomendaciones concretas con números cuando sea posible  
3. Prioriza acciones de alto impacto en el corto plazo
4. Reporta en formato ejecutivo: situación → análisis → acción recomendada

Respondes siempre en español. Tono: directo, ejecutivo, sin rodeos.`
  },

  supervisor: {
    nombre: "FUNDORA SUPERVISOR",
    modelo: MODELOS.rapido,
    area: "Control",
    system: `Eres el Supervisor de Fundora Agency AI. Tu rol es validar planes antes de ejecutarlos y anticipar riesgos. Siempre respondes en JSON: {"valido": true/false, "riesgos": [], "sugerencias": [], "aprobado": true/false}`
  },

  corrector: {
    nombre: "FUNDORA CORRECTOR", 
    modelo: MODELOS.rapido,
    area: "Control",
    system: `Eres el Corrector de Fundora Agency AI. Analizas errores y propones soluciones específicas. Respondes en JSON: {"diagnostico": "...", "causa_raiz": "...", "solucion": "...", "pasos": []}`
  },

  verificador: {
    nombre: "FUNDORA VERIFICADOR",
    modelo: MODELOS.rapido,
    area: "Control",
    system: `Eres el Verificador de Fundora Agency AI. Revisas que los resultados sean correctos y completos. Respondes en JSON: {"resultado": "APROBADO|FALLIDO|PARCIAL", "razon": "...", "observaciones": []}`
  },

  rastreador: {
    nombre: "FUNDORA RASTREADOR",
    modelo: MODELOS.rapido,
    area: "Inteligencia",
    system: `Eres el Rastreador Inteligente de Fundora Agency AI. Buscas, sintetizas y organizas información de fuentes confiables. Priorizas datos recientes, verificados y accionables. Formato: resumen ejecutivo + fuentes + relevancia para el negocio.`
  },

  // ── ESPECIALISTAS ──
  programador: {
    nombre: "FUNDORA DEV",
    modelo: MODELOS.codigo,
    area: "Tecnología",
    system: `Eres FUNDORA DEV, arquitecto de software de Fundora Prime Atlantic. Especializado en: Node.js, React, TypeScript, Python, APIs REST, Supabase, Cloudflare Workers, Vercel, Termux/Android.

Stack del ecosistema Fundora:
- PAS: React + Vite + Tailwind + Supabase (Vercel)
- BetGroup Pro: Node.js + Express + Cloudflare AI (Render/Termux)  
- FUNDORA AGENCY AI: Node.js + Express + CF AI (Termux + Cloudflare Tunnel)

PROTOCOLO: Primero arquitectura, luego código. Código limpio, comentado, con manejo de errores. Siempre verifica que funcione en Termux (Android) cuando sea relevante.`
  },

  director: {
    nombre: "FUNDORA VISION",
    modelo: MODELOS.potente,
    area: "Producción",
    system: `Eres FUNDORA VISION, director creativo y de producción audiovisual de Fundora Agency AI. Experto en: prompts para generación de imágenes (Stable Diffusion, SDXL, FLUX), dirección de video, identidad visual, branding.

PROTOCOLO para prompts de imagen: [estilo visual], [sujeto principal], [composición], [iluminación], [calidad], [formato]. Ejemplo: "professional corporate logo, abstract geometric design, minimalist, dark background, 8k, vector art"

Para video: piensa en secuencia de frames, movimiento de cámara, ritmo visual, coherencia de estilo entre frames.`
  },

  financiero: {
    nombre: "FUNDORA FINANCE",
    modelo: MODELOS.potente,
    area: "Finanzas",
    system: `Eres FUNDORA FINANCE, analista financiero de Fundora Prime Atlantic. Conoces el modelo de negocio de PAS (marketplace de importación Miami-TCI), BetGroup Pro (apuestas deportivas) y FUNDORA AGENCY AI (SaaS).

PROTOCOLO: Datos primero, opiniones después. Siempre incluye: métricas clave, proyecciones numéricas, riesgos financieros, recomendación accionable. Formato: tabla cuando sea posible.`
  },

  marketing: {
    nombre: "FUNDORA MARKET",
    modelo: MODELOS.rapido,
    area: "Marketing",
    system: `Eres FUNDORA MARKET, estratega de marketing digital para el ecosistema Fundora. Especializado en: marketing para el Caribe y LATAM, comunidades cubanas en el exterior, TikTok/Instagram para negocios locales, copywriting de alto impacto.

PROTOCOLO: Audiencia → mensaje → canal → CTA. Siempre orientado a conversión, no solo awareness.`
  },

  abogado: {
    nombre: "FUNDORA LEX",
    modelo: MODELOS.potente,
    area: "Legal",
    system: `Eres FUNDORA LEX, asesor legal de Fundora Prime Atlantic LLC (empresa registrada en TCI). Conoces regulaciones de: Turks and Caicos Islands, importación/exportación Miami-TCI, contratos SaaS, términos de servicio, GDPR básico.

PROTOCOLO: Siempre advierte que no reemplazas a un abogado certificado. Analiza riesgos legales, propón lenguaje contractual, identifica puntos críticos. Formato: riesgo (alto/medio/bajo) → análisis → recomendación.`
  },

  psicologo: {
    nombre: "FUNDORA MIND",
    modelo: MODELOS.potente,
    area: "Bienestar",
    system: `Eres FUNDORA MIND, psicólogo organizacional y coach de rendimiento de Fundora Agency AI. Ayudas a: tomar decisiones bajo presión, gestionar equipos, mantener el foco como CEO emprendedor, superar bloqueos mentales.

PROTOCOLO: Escucha activa → identificar patrón → herramienta concreta → seguimiento. Tono cálido pero directo. No psicoanálisis, sino herramientas prácticas.`
  },

  medico: {
    nombre: "FUNDORA HEALTH",
    modelo: MODELOS.potente,
    area: "Salud",
    system: `Eres FUNDORA HEALTH, asesor de salud y bienestar optimizado para emprendedores de alto rendimiento. Información basada en evidencia sobre: nutrición para el foco, sueño, ejercicio, gestión del estrés crónico.

PROTOCOLO: Siempre aclara que no reemplazas a un médico. Información práctica y accionable. Foco en rendimiento sostenible, no en soluciones rápidas.`
  },

  analista: {
    nombre: "FUNDORA SPORTS",
    modelo: MODELOS.potente,
    area: "Deportes",
    system: `Eres FUNDORA SPORTS, analista de datos deportivos y apuestas de Fundora Agency AI. Soporte directo para BetGroup Pro. Especializado en: análisis estadístico de partidos, probabilidades, tendencias, value betting.

PROTOCOLO: Datos objetivos, no predicciones subjetivas. Siempre incluye: nivel de confianza, variables consideradas, limitaciones del análisis. Formato: tabla comparativa cuando sea posible.`
  },

  ecommerce: {
    nombre: "FUNDORA SHOP",
    modelo: MODELOS.rapido,
    area: "Comercio",
    system: `Eres FUNDORA SHOP, especialista en comercio electrónico y el marketplace de importación PAS (Prime Atlantic Solutions). Conoces el flujo Miami→TCI, los proveedores, la logística del Caribe, y la experiencia del cliente en contextos de baja bancarización.

PROTOCOLO: Conversión primero. Siempre piensa en el journey del cliente desde el primer clic hasta la entrega.`
  },

  turismo: {
    nombre: "FUNDORA TRAVEL",
    modelo: MODELOS.rapido,
    area: "Turismo",
    system: `Eres FUNDORA TRAVEL, especialista en turismo del Caribe con base en Providenciales, Turks and Caicos. Conoces el mercado de lujo, los destinos del archipiélago, y las oportunidades de negocio en hotelería y experiencias premium.

PROTOCOLO: Experiencia del cliente premium. Siempre incluye: qué ofrecer, cómo diferenciarse, cómo monetizar.`
  },

  gastronomico: {
    nombre: "FUNDORA CHEF",
    modelo: MODELOS.rapido,
    area: "Gastronomía",
    system: `Eres FUNDORA CHEF, consultor gastronómico especializado en el Caribe. Combinas cocina, negocio y marketing. Ayudas con: menús rentables, control de costos, estrategia de F&B, marketing gastronómico en redes.

PROTOCOLO: Rentabilidad primero, creatividad después. Siempre incluye costos estimados y margen cuando sea posible.`
  },

  rrhh: {
    nombre: "FUNDORA HR",
    modelo: MODELOS.rapido,
    area: "Recursos Humanos",
    system: `Eres FUNDORA HR, director de recursos humanos virtual de Fundora Prime Atlantic. Especializado en: equipos remotos y distribuidos, contratación en el Caribe/LATAM, cultura organizacional para startups, onboarding digital.

PROTOCOLO: Personas primero. Siempre equilibra los intereses de la empresa con el bienestar del equipo.`
  },

  educador: {
    nombre: "FUNDORA EDU",
    modelo: MODELOS.rapido,
    area: "Educación",
    system: `Eres FUNDORA EDU, diseñador instruccional de Fundora Agency AI. Ayudas a crear: cursos online, tutoriales, documentación técnica, materiales de capacitación. Especializado en aprendizaje para adultos y formatos digitales.

PROTOCOLO: Objetivo de aprendizaje primero. Estructura: introducción → contenido → práctica → evaluación.`
  },

  inmobiliario: {
    nombre: "FUNDORA REALTY",
    modelo: MODELOS.potente,
    area: "Inmobiliaria",
    system: `Eres FUNDORA REALTY, asesor inmobiliario del Caribe. Especializado en el mercado de Turks and Caicos, inversión inmobiliaria en islas, regulaciones para compradores extranjeros, y oportunidades de desarrollo.

PROTOCOLO: Due diligence primero. Siempre incluye: análisis de mercado, riesgos, rendimiento esperado, pasos legales necesarios.`
  },

  agro: {
    nombre: "FUNDORA AGRO",
    modelo: MODELOS.rapido,
    area: "Agricultura",
    system: `Eres FUNDORA AGRO, consultor agrícola y de tecnología aplicada al campo. Especializado en: agricultura tropical, hidropónica, eficiencia hídrica, tecnología para pequeños y medianos agricultores de LATAM y el Caribe.

PROTOCOLO: Soluciones adaptadas al contexto local. Siempre considera: clima, recursos disponibles, mercado local.`
  },

  creativo: {
    nombre: "FUNDORA VISION CREATIVA",
    modelo: MODELOS.potente,
    area: "Creatividad",
    system: `Eres FUNDORA VISION CREATIVA, director creativo de contenido de Fundora Agency AI. Especializado en: guiones, copywriting, narrativa de marca, prompts creativos para IA, libros y contenido largo.

PROTOCOLO: La creatividad sirve a un objetivo. Siempre pregunta: ¿a quién va dirigido? ¿qué emoción queremos provocar? ¿cuál es el CTA?`
  }
};

// ══════════════════════════════════════════════
//  DETECCIÓN DE INTENCIONES
// ══════════════════════════════════════════════
function detectarIntencion(mensaje) {
  const m = mensaje.toLowerCase();
  
  // IMAGEN
  if (/\b(genera|crea|diseña|hazme|dame|haz|hacer|diseñar|generar|crear|mostrar|quiero|necesito)\b.*\b(imagen|foto|logo|banner|poster|diseño|ilustración|portada|miniatura|thumbnail|avatar|icon|icono|cartel|afiche|flyer|visual)\b/i.test(m) ||
      /\b(imagen|foto|logo|banner|poster|diseño|ilustración)\b.*\b(de|para|del|con|sobre)\b/i.test(m)) {
    return { tipo: "imagen", confianza: "alta" };
  }
  
  // VIDEO
  if (/\b(genera|crea|hazme|haz|hacer|generar|crear)\b.*\b(video|clip|animación|animacion|reels|reel|corto|film)\b/i.test(m) ||
      /\b(video|clip|animación)\b.*\b(de|para|del|sobre)\b/i.test(m)) {
    return { tipo: "video", confianza: "alta" };
  }
  
  // PDF/DOCUMENTO
  if (/\b(genera|crea|hazme|haz|hacer|generar|crear|exporta|exportar)\b.*\b(pdf|documento|informe|reporte|report|propuesta|contrato|presupuesto|cotización)\b/i.test(m) ||
      /\b(pdf|documento|informe|reporte)\b.*\b(de|para|del|sobre)\b/i.test(m)) {
    return { tipo: "pdf", confianza: "alta" };
  }
  
  // CÓDIGO
  if (/\b(programa|desarrolla|escribe|crea|genera|haz)\b.*\b(código|codigo|script|app|aplicación|aplicacion|función|funcion|api|endpoint|bot|automatización|automatizacion)\b/i.test(m) ||
      /\b(en javascript|en python|en node|en react|en typescript)\b/i.test(m)) {
    return { tipo: "codigo", confianza: "alta" };
  }
  
  return { tipo: "chat", confianza: "alta" };
}

// ══════════════════════════════════════════════
//  LLAMADA A CLOUDFLARE AI
// ══════════════════════════════════════════════
async function llamarCF(modelo, mensajes, maxTokens = 1200) {
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${modelo}`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: mensajes, max_tokens: maxTokens })
    }
  );
  const data = await resp.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors));
  return data.result.response;
}

// ══════════════════════════════════════════════
//  MEMORIA Y CONOCIMIENTO
// ══════════════════════════════════════════════
const memorias = {};
const conocimientoExtra = {};
const cacheConocimiento = {};

async function getMemoria(sessionId, agenteId) {
  if (!memorias[sessionId]) {
    const agente = AGENTES[agenteId] || AGENTES.general;
    let extra = conocimientoExtra[agenteId] ? "\n\nCONOCIMIENTO ADICIONAL:\n" + conocimientoExtra[agenteId] : "";
    memorias[sessionId] = {
      agenteId,
      historial: [{ role: "system", content: agente.system + extra }],
      creado: Date.now(),
      totalMensajes: 0
    };
  }
  return memorias[sessionId];
}

async function guardarMemoria(agenteId, sessionId, tipo, contenido) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/agent_memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ agente_id: agenteId, session_id: sessionId, tipo, contenido, timestamp: new Date().toISOString() })
    });
  } catch(e) {}
}

// ══════════════════════════════════════════════
//  GENERADORES (usados por el orquestador)
// ══════════════════════════════════════════════
async function generarImagen(prompt) {
  // Optimizar prompt con FUNDORA VISION
  let promptOpt = prompt;
  try {
    promptOpt = await llamarCF(AGENTES.director.modelo, [
      { role: "system", content: AGENTES.director.system + " Responde SOLO con el prompt optimizado para Stable Diffusion, máximo 200 caracteres." },
      { role: "user", content: "Optimiza para imagen de alta calidad: " + prompt }
    ], 200);
  } catch(e) {}

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: promptOpt, num_steps: 20 })
  });
  const contentType = resp.headers.get("content-type") || "";
  let base64;
  if (contentType.includes("application/json")) {
    const data = await resp.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors));
    base64 = Buffer.from(data.result.image, "base64").toString("base64");
  } else {
    const buffer = await resp.arrayBuffer();
    base64 = Buffer.from(buffer).toString("base64");
  }
  return { imagen: "data:image/png;base64," + base64, prompt_usado: promptOpt };
}

async function generarVideo(prompt, frames = 5) {
  const imagenes = [];
  for (let i = 0; i < frames; i++) {
    const fp = `${prompt}, frame ${i+1} of ${frames}, cinematic, consistent style, smooth animation`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: fp, num_steps: 15 })
    });
    let base64;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const d = await resp.json();
      if (d.success) base64 = Buffer.from(d.result.image, "base64").toString("base64");
    } else {
      const buf = await resp.arrayBuffer();
      base64 = Buffer.from(buf).toString("base64");
    }
    if (base64) {
      imagenes.push(base64);
      fs.writeFileSync(`/tmp/vframe_${i}.png`, Buffer.from(base64, "base64"));
    }
  }
  if (imagenes.length >= 2) {
    try {
      execSync("ffmpeg -y -framerate 1 -i /tmp/vframe_%d.png -c:v libx264 -pix_fmt yuv420p /tmp/vout.mp4 2>/dev/null");
      const videoBuf = fs.readFileSync("/tmp/vout.mp4");
      const videoB64 = videoBuf.toString("base64");
      for (let i = 0; i < frames; i++) { try { fs.unlinkSync(`/tmp/vframe_${i}.png`); } catch(e) {} }
      try { fs.unlinkSync("/tmp/vout.mp4"); } catch(e) {}
      return { video: "data:video/mp4;base64," + videoB64, frames: imagenes.length };
    } catch(e) {
      return { imagenes: imagenes.map(img => "data:image/png;base64," + img), frames: imagenes.length, nota: "Video en frames (ffmpeg no disponible)" };
    }
  }
  throw new Error("No se pudieron generar suficientes frames");
}

async function generarPDF(titulo, contenido) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => {
      const b64 = Buffer.concat(chunks).toString("base64");
      resolve({ pdf: "data:application/pdf;base64," + b64, nombre: titulo + ".pdf" });
    });
    doc.on("error", reject);
    doc.fontSize(22).font("Helvetica-Bold").text(titulo, { align: "center" });
    doc.moveDown(1.5);
    doc.fontSize(12).font("Helvetica").text(contenido, { align: "left", lineGap: 4 });
    doc.end();
  });
}

// ══════════════════════════════════════════════
//  AGENTES DE CONTROL (internos)
// ══════════════════════════════════════════════
async function validarPensamiento(tarea, contexto = "") {
  try {
    const resp = await llamarCF(AGENTES.supervisor.modelo, [
      { role: "system", content: AGENTES.supervisor.system },
      { role: "user", content: `Tarea: "${tarea}". Contexto: ${contexto}. Responde JSON.` }
    ], 300);
    return JSON.parse(resp);
  } catch(e) { return { valido: true, riesgos: [], sugerencias: [], aprobado: true }; }
}

async function consultarCorrector(errorMsg, comando) {
  try {
    const resp = await llamarCF(AGENTES.corrector.modelo, [
      { role: "system", content: AGENTES.corrector.system },
      { role: "user", content: `Error: ${errorMsg}. Comando: ${comando}. Responde JSON.` }
    ], 300);
    return JSON.parse(resp);
  } catch(e) { return { diagnostico: "No analizado.", solucion: "Revisar manualmente." }; }
}

async function verificarResultado(texto, tipo = "general") {
  try {
    const resp = await llamarCF(AGENTES.verificador.modelo, [
      { role: "system", content: AGENTES.verificador.system },
      { role: "user", content: `Tipo: ${tipo}. Contenido: ${texto.substring(0,2000)}. Responde JSON.` }
    ], 200);
    return JSON.parse(resp);
  } catch(e) { return { resultado: "APROBADO", razon: "Verificación no disponible." }; }
}

// ══════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════
app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => { logger.info(`${req.method} ${req.path}`); next(); });
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Role");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.static("public"));

// ══════════════════════════════════════════════
//  ENDPOINTS PRINCIPALES
// ══════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    nombre: "FUNDORA AGENCY AI",
    version: "4.0",
    agentes: Object.keys(AGENTES).length,
    uptime_horas: (process.uptime() / 3600).toFixed(2),
    capacidades: ["chat", "imagen", "video", "pdf", "codigo", "terminal"],
    orquestador: "activo"
  });
});

app.get("/agentes", (req, res) => {
  const lista = Object.keys(AGENTES).map(id => ({
    id,
    nombre: AGENTES[id].nombre,
    modelo: AGENTES[id].modelo,
    area: AGENTES[id].area || "General"
  }));
  res.json({ agentes: lista, total: lista.length });
});

// ══════════════════════════════════════════════
//  /chat — ORQUESTADOR PRINCIPAL
//  Detecta intención → ejecuta automáticamente
// ══════════════════════════════════════════════
app.post("/chat", async (req, res) => {
  const { mensaje, agente: agenteId = "general", sessionId = "default" } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });

  try {
    const config = AGENTES[agenteId] || AGENTES.general;
    const memoria = await getMemoria(sessionId, agenteId);
    
    // 1. Detectar intención del mensaje
    const intencion = detectarIntencion(mensaje);
    
    // 2. Si es acción directa (imagen/video/pdf), ejecutar sin pasar por el LLM primero
    if (intencion.tipo !== "chat" && agenteId === "general") {
      
      memoria.historial.push({ role: "user", content: mensaje });
      
      try {
        let resultado = {};
        let textoRespuesta = "";
        
        if (intencion.tipo === "imagen") {
          textoRespuesta = `🎨 Generando imagen para: "${mensaje}"...`;
          const r = await generarImagen(mensaje);
          resultado = { accion: "imagen", ...r };
          textoRespuesta = `✅ Imagen generada. Prompt usado: "${r.prompt_usado}"`;
          
        } else if (intencion.tipo === "video") {
          textoRespuesta = `🎬 Generando video para: "${mensaje}"...`;
          const r = await generarVideo(mensaje, 5);
          resultado = { accion: "video", ...r };
          textoRespuesta = r.video 
            ? `✅ Video generado (${r.frames} frames → MP4)`
            : `✅ Secuencia de ${r.frames} frames generada`;
            
        } else if (intencion.tipo === "pdf") {
          // Generar contenido con el agente primero
          const contenidoPDF = await llamarCF(config.modelo, [
            { role: "system", content: config.system },
            { role: "user", content: "Genera el contenido completo para este documento: " + mensaje }
          ], 1500);
          const titulo = mensaje.replace(/genera|crea|hazme|un|una|el|la|pdf|documento|informe/gi, "").trim().slice(0, 50) || "Documento Fundora";
          const r = await generarPDF(titulo, contenidoPDF);
          resultado = { accion: "pdf", ...r };
          textoRespuesta = `✅ PDF generado: "${titulo}.pdf"`;
          
        } else if (intencion.tipo === "codigo") {
          const codigoResp = await llamarCF(AGENTES.programador.modelo, [
            { role: "system", content: AGENTES.programador.system },
            { role: "user", content: mensaje }
          ], 2000);
          resultado = { accion: "codigo", codigo: codigoResp };
          textoRespuesta = codigoResp;
        }
        
        memoria.historial.push({ role: "assistant", content: textoRespuesta });
        memoria.totalMensajes++;
        guardarMemoria(agenteId, sessionId, "chat", `USER: ${mensaje} | ACCION: ${intencion.tipo}`);
        
        return res.json({
          agente: config.nombre,
          respuesta: textoRespuesta,
          sessionId,
          mensajes: memoria.totalMensajes,
          ...resultado
        });
        
      } catch(accionError) {
        // Si la acción falla, continuar con chat normal
        logger.warn(`Acción ${intencion.tipo} falló: ${accionError.message}`);
      }
    }
    
    // 3. Chat normal con memoria
    memoria.historial.push({ role: "user", content: mensaje });
    const respuesta = await llamarCF(config.modelo, memoria.historial, 1200);
    
    // 4. Parsear si el agente devuelve JSON con acciones (agente general entrenado para esto)
    let respuestaFinal = respuesta;
    let extras = {};
    try {
      const jsonMatch = respuesta.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.accion && parsed.accion !== "chat") {
          // El agente decidió ejecutar una acción
          respuestaFinal = parsed.texto || respuesta;
          if (parsed.accion === "imagen" && parsed.parametros?.prompt) {
            const r = await generarImagen(parsed.parametros.prompt);
            extras = { accion: "imagen", ...r };
            respuestaFinal = parsed.texto + `\n\n✅ Imagen generada.`;
          } else if (parsed.accion === "pdf" && parsed.parametros) {
            const r = await generarPDF(parsed.parametros.titulo || "Documento", parsed.parametros.contenido || "");
            extras = { accion: "pdf", ...r };
            respuestaFinal = parsed.texto + `\n\n✅ PDF generado.`;
          }
        } else if (parsed.texto) {
          respuestaFinal = parsed.texto;
        }
      }
    } catch(e) {} // Si no es JSON válido, usar respuesta tal cual
    
    memoria.historial.push({ role: "assistant", content: respuestaFinal });
    memoria.totalMensajes++;
    guardarMemoria(agenteId, sessionId, "chat", `USER: ${mensaje} | BOT: ${respuestaFinal.slice(0,200)}`);
    
    res.json({
      agente: config.nombre,
      respuesta: respuestaFinal,
      sessionId,
      mensajes: memoria.totalMensajes,
      ...extras
    });
    
  } catch(e) {
    logger.error("Error /chat:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
//  GENERADORES DIRECTOS (para uso desde Studio)
// ══════════════════════════════════════════════

app.post("/generar/imagen", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  try {
    const r = await generarImagen(prompt);
    res.json({ status: "ok", ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/generar/imagen-ilimitado", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  const modelos = ["black-forest-labs/FLUX.1-dev", "stabilityai/stable-diffusion-xl-base-1.0", "nota-ai/bk-sdm-small"];
  for (const modelo of modelos) {
    try {
      const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${modelo}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: prompt })
      });
      if (resp.ok) {
        const buffer = await resp.buffer();
        return res.json({ status: "ok", imagen: "data:image/png;base64," + buffer.toString("base64"), modelo });
      }
    } catch(e) { continue; }
  }
  // Fallback a Cloudflare
  try {
    const r = await generarImagen(prompt);
    res.json({ status: "ok", ...r, modelo: "cloudflare-fallback" });
  } catch(e) { res.status(500).json({ error: "Todos los modelos fallaron" }); }
});

app.post("/generar/video", async (req, res) => {
  const { prompt, frames = 5 } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  try {
    const r = await generarVideo(prompt, frames);
    res.json({ status: "ok", ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/generar/video-cloudflare", async (req, res) => {
  const { prompt, frames = 5 } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta prompt" });
  try {
    const r = await generarVideo(prompt, frames);
    res.json({ status: "ok", ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/generar/pdf", async (req, res) => {
  const { titulo = "Documento", contenido = "", imagen } = req.body;
  if (!contenido && !imagen) return res.status(400).json({ error: "Falta contenido o imagen" });
  try {
    const r = await generarPDF(titulo, contenido);
    res.json({ status: "ok", ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/generar/img2img", upload.single("imagen"), async (req, res) => {
  const { prompt } = req.body;
  if (!req.file || !prompt) return res.status(400).json({ error: "Falta imagen y/o prompt" });
  try {
    const r = await generarImagen(prompt + ", based on a reference image, high quality, detailed");
    res.json({ status: "ok", ...r, nota: "img2img simulado" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  ENDPOINTS COMPLEMENTARIOS
// ══════════════════════════════════════════════

app.post("/consulta", async (req, res) => {
  const { mensaje, agente = "general" } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });
  const config = AGENTES[agente] || AGENTES.general;
  try {
    const respuesta = await llamarCF(config.modelo, [
      { role: "system", content: config.system },
      { role: "user", content: mensaje }
    ], 800);
    res.json({ agente: config.nombre, respuesta });
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
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/learning_logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ agente_id: agenteId, session_id: sessionId || "default", consulta: consulta || "", respuesta: respuesta || "", puntuacion, comentario: comentario || "", timestamp: new Date().toISOString() })
    });
    res.json({ status: "ok" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/memoria/:agenteId", async (req, res) => {
  const { agenteId } = req.params;
  const sessionId = req.query.sessionId || "default";
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/agent_memory?select=contenido,tipo,timestamp&agente_id=eq.${agenteId}&session_id=eq.${sessionId}&order=timestamp.desc&limit=20`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const memoria = await resp.json();
    res.json({ agente: agenteId, sessionId, memoria, total: memoria.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/memoria/buscar", async (req, res) => {
  const { consulta } = req.body;
  if (!consulta) return res.status(400).json({ error: "Falta consulta" });
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/agent_memory?select=agente_id,contenido&order=timestamp.desc&limit=50`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const registros = await resp.json();
    const resultados = registros.filter(r => consulta.toLowerCase().split(/\s+/).some(p => (r.contenido || "").toLowerCase().includes(p))).slice(0, 5);
    res.json({ consulta, resultados });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/agentes/:id/conocimiento", async (req, res) => {
  const { id } = req.params;
  const { conocimiento } = req.body;
  if (!conocimiento) return res.status(400).json({ error: "Falta conocimiento" });
  conocimientoExtra[id] = (conocimientoExtra[id] || "") + "\n" + conocimiento;
  // Invalidar memoria activa para que tome el nuevo conocimiento
  Object.keys(memorias).forEach(sid => { if (memorias[sid].agenteId === id) delete memorias[sid]; });
  res.json({ success: true, agente: id });
});

app.get("/agentes/:id/conocimiento", (req, res) => {
  const { id } = req.params;
  res.json({ agente: id, conocimiento: conocimientoExtra[id] || "" });
});

app.post("/agentes/crear", (req, res) => {
  const { id, nombre, system, modelo = "potente" } = req.body;
  if (!id || !nombre || !system) return res.status(400).json({ error: "Faltan campos: id, nombre, system" });
  if (AGENTES[id]) return res.status(409).json({ error: "El agente ya existe" });
  AGENTES[id] = { nombre, modelo: MODELOS[modelo] || MODELOS.rapido, area: "Custom", system };
  res.json({ success: true, agente: { id, nombre, modelo: AGENTES[id].modelo } });
});

app.post("/agentes/:id/clonar", (req, res) => {
  const { id } = req.params;
  const { nuevoId, nuevoNombre } = req.body;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente no encontrado" });
  if (!nuevoId || !nuevoNombre) return res.status(400).json({ error: "Faltan nuevoId y nuevoNombre" });
  AGENTES[nuevoId] = { ...AGENTES[id], nombre: nuevoNombre };
  res.json({ success: true, agente: { id: nuevoId, nombre: nuevoNombre } });
});

app.post("/ejecutar", async (req, res) => {
  const { tarea } = req.body;
  if (!tarea) return res.status(400).json({ error: "Falta tarea" });
  const validacion = await validarPensamiento(tarea);
  if (!validacion.valido) return res.json({ status: "rechazado", riesgos: validacion.riesgos, sugerencias: validacion.sugerencias });
  res.json({ status: "ok", mensaje: "Tarea validada." });
});

app.post("/simular", async (req, res) => {
  const { comandos, contexto } = req.body;
  if (!comandos || !Array.isArray(comandos)) return res.status(400).json({ error: "Se requiere array de comandos" });
  const validacion = await validarPensamiento(comandos.join(" | "), contexto || "Simulación");
  if (!validacion.valido) return res.json({ status: "rechazado", riesgos: validacion.riesgos, sugerencias: validacion.sugerencias });
  const resultados = [];
  for (const cmd of comandos) {
    const sandbox = (() => { const d = `/tmp/fsim-${Math.random().toString(36).slice(2)}`; fs.mkdirSync(d, { recursive: true }); return d; })();
    try {
      const resultado = await new Promise(resolve => {
        exec(cmd, { cwd: sandbox, timeout: 10000, maxBuffer: 1024*200 }, (error, stdout, stderr) => {
          resolve({ comando: cmd, stdout: stdout||"", stderr: stderr||"", error: error?.message||null });
        });
      });
      resultados.push(resultado);
    } catch(e) { resultados.push({ comando: cmd, error: e.message }); }
    finally { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch(e) {} }
  }
  res.json({ status: "ok", total: resultados.length, resultados, validacion });
});

app.post("/upload", upload.single("archivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo" });
  try {
    const fileName = `${Date.now()}-${req.file.originalname}`;
    const base64Data = req.file.buffer.toString("base64");
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/archivos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Prefer": "return=representation" },
      body: JSON.stringify({ nombre: fileName, tipo: req.file.mimetype, data: base64Data })
    });
    if (resp.ok) {
      const inserted = await resp.json();
      res.json({ status: "ok", id: inserted[0]?.id, nombre: fileName });
    } else {
      res.status(500).json({ error: "Error guardando archivo" });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/biblioteca", async (req, res) => {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/archivos?select=id,nombre,tipo,created_at&order=created_at.desc&limit=50`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const archivos = await resp.json();
    res.json({ archivos, total: archivos.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GROQ ──
app.post("/groq/chat", async (req, res) => {
  const { mensaje, modelo = "rapido", agente = "general" } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });
  const config = AGENTES[agente] || AGENTES.general;
  const model = GROQ_MODELS[modelo] || GROQ_MODELS.rapido;
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: config.system }, { role: "user", content: mensaje }], max_tokens: 1000 })
    });
    const data = await resp.json();
    res.json({ respuesta: data?.choices?.[0]?.message?.content || "Sin respuesta", modelo: model, motor: "groq" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── JWT ──
const BOTPRESS_PAT = "bp_pat_P0qf7HAVhl15wfGz2UMoM4ZiQfHzbzmD5yNx";
const BOTPRESS_BOT_ID = "32429f0f-8a50-4787-ad93-7a6d8bc06cce";

app.post("/enviar/whatsapp", async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: "Falta telefono o mensaje" });
  try {
    const resp = await fetch("https://api.botpress.cloud/v1/chat/messages", {
      method: "POST",
      headers: { "Authorization": `Bearer ${BOTPRESS_PAT}`, "Content-Type": "application/json", "x-bot-id": BOTPRESS_BOT_ID },
      body: JSON.stringify({ userId: `whatsapp:${telefono}`, type: "text", tags: {}, conversationId: `wa-${telefono}-${Date.now()}`, payload: { type: "text", text: mensaje } })
    });
    if (resp.ok) res.json({ status: "ok" });
    else { const err = await resp.text(); res.status(500).json({ error: err }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/auth/login", (req, res) => {
  const { usuario, password } = req.body;
  if (usuario === "admin" && password === "Fundora2026!") {
    res.json({ token: jwt.sign({ rol: "admin" }, JWT_SECRET, { expiresIn: "24h" }) });
  } else {
    res.status(401).json({ error: "Credenciales inválidas" });
  }
});

app.post("/sql", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Falta query" });
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ query })
    });
    const data = await resp.json();
    res.json({ status: "ok", resultado: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/stats", (req, res) => {
  res.json({
    agentes_total: Object.keys(AGENTES).length,
    sesiones_activas: Object.keys(memorias).length,
    agentes_con_conocimiento: Object.keys(conocimientoExtra).length,
    uptime_horas: (process.uptime() / 3600).toFixed(2),
    modelos: {
      potente: MODELOS.potente,
      rapido: MODELOS.rapido,
      codigo: MODELOS.codigo
    }
  });
});

app.get("/skills", (req, res) => {
  res.json({
    sistema: "FUNDORA AGENCY AI v4.0",
    agentes: Object.keys(AGENTES).length,
    orquestador: "Detección automática de intenciones — imagen, video, PDF, código",
    endpoints: [
      "GET /health", "GET /agentes", "GET /stats", "GET /skills",
      "POST /chat (orquestador — detecta imagen/video/pdf/codigo automáticamente)",
      "POST /consulta", "POST /verificar", "POST /validar", "POST /feedback",
      "GET /memoria/:agenteId", "POST /memoria/buscar",
      "POST /agentes/crear", "POST /agentes/:id/clonar", "POST /agentes/:id/conocimiento",
      "POST /generar/imagen", "POST /generar/imagen-ilimitado",
      "POST /generar/img2img", "POST /generar/video", "POST /generar/video-cloudflare",
      "POST /generar/pdf", "POST /upload", "GET /biblioteca",
      "POST /groq/chat", "POST /ejecutar", "POST /simular", "POST /sql",
      "POST /enviar/whatsapp", "POST /auth/login",
      "WS /terminal", "GET /dashboard"
    ]
  });
});

// ══════════════════════════════════════════════
//  WEBSOCKET TERMINAL
// ══════════════════════════════════════════════
app.ws("/terminal", (ws, req) => {
  ws.send("FUNDORA AGENCY AI v4.0 — Terminal\n$ ");
  ws.on("message", async (msg) => {
    const cmd = msg.toString().trim();
    if (!cmd) return;
    if (/rm\s+-rf\s+\/|sudo|chmod\s+777/i.test(cmd)) { ws.send("Bloqueado por seguridad.\n$ "); return; }
    exec(cmd, { cwd: SAFE_ROOT, timeout: 15000, maxBuffer: 1024*500 }, async (error, stdout, stderr) => {
      if (stdout) ws.send(stdout);
      if (stderr) ws.send(stderr);
      if (error) {
        ws.send(`\n❌ Error: ${error.message}\n`);
        const c = await consultarCorrector(error.message, cmd);
        ws.send(`🧠 Diagnóstico: ${c.diagnostico}\n💡 Solución: ${c.solucion}\n`);
      } else {
        const v = await verificarResultado(stdout || "", "comando");
        ws.send(`✅ ${v.resultado}: ${v.razon}\n`);
      }
      ws.send("$ ");
    });
  });
});

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

// ══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ FUNDORA AGENCY AI v4.0 en puerto ${PORT}`);
  console.log(`🤖 ${Object.keys(AGENTES).length} agentes activos`);
  console.log(`⚡ Orquestador de intenciones: ACTIVO`);
  console.log(`🎨 Imagen | 🎬 Video | 📄 PDF | ⌨️ Código — sin botones, solo pedirlo`);
});
