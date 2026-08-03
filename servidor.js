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
//  MONITOR — la consola en vivo del "Centro de Control"
//  Capturamos cada registro del servidor en un buffer y
//  lo transmitimos a los navegadores que estén viendo el Monitor.
// ══════════════════════════════════════════════
const bufferLogs = [];            // últimas líneas de registro (memoria)
const clientesSSE = new Set();    // navegadores viendo la consola en vivo
const MAX_LOGS = 250;

// Decide el color de la línea: rojo (error), ámbar (aviso) o gris (normal)
function _nivelLog(msg, base) {
  const m = String(msg).toLowerCase();
  if (base === "error") return "error";
  if (/error|falló|fallo|failed|exception|no se pudo|✗|❌/.test(m)) return "error";
  if (base === "warn" || /advertencia|warning|deprecat|⚠/.test(m)) return "warn";
  return "info";
}
function registrarLog(base, args) {
  let msg;
  try { msg = args.map(a => (a && typeof a === "object") ? JSON.stringify(a) : String(a)).join(" "); }
  catch(e) { msg = args.join(" "); }
  const linea = { t: Date.now(), nivel: _nivelLog(msg, base), msg };
  bufferLogs.push(linea);
  if (bufferLogs.length > MAX_LOGS) bufferLogs.shift();
  const paquete = "data: " + JSON.stringify(linea) + "\n\n";
  for (const res of clientesSSE) { try { res.write(paquete); } catch(e) {} }
}
// Envolvemos console.* SIN perder la salida normal a la terminal
const _log = console.log.bind(console), _warn = console.warn.bind(console), _error = console.error.bind(console);
console.log   = (...a) => { _log(...a);   registrarLog("info", a); };
console.warn  = (...a) => { _warn(...a);  registrarLog("warn", a); };
console.error = (...a) => { _error(...a); registrarLog("error", a); };

// ══════════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://vmjmiabxjmcrovnirbkj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CF_TOKEN || "";
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || ""; // voz de Google, gratis hasta 1M/4M caracteres al mes
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // ojos del agente (Google AI Studio, gratis sin tarjeta)
const GROQ_KEY = process.env.GROQ_KEY || "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";
const JWT_SECRET = process.env.JWT_SECRET || "fundora-ai-secreto-2026";
const SAFE_ROOT = __dirname; // Antes usaba os.homedir()+"fundora-ai" (solo válido por coincidencia en Termux);
                              // __dirname siempre apunta a la carpeta donde vive ESTE archivo, así que
                              // funciona igual en Termux, en Render, o en cualquier otro servidor futuro.
// Termux NO tiene /tmp — usamos un directorio propio dentro de fundora-ai
const TMP_DIR = path.join(SAFE_ROOT, ".tmp");
try { if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true }); } catch(e) {}

// Modelos disponibles
const MODELOS = {
  // ── TEXTO ──
  potente:  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  rapido:   "@cf/meta/llama-3.1-8b-instruct",
  codigo:   "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // fallback, ideal: qwen-coder
  analisis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  // ── IMAGEN ──
  imagen:      "@cf/black-forest-labs/flux-1-schnell",              // Principal: mejor calidad, más rápido, ~100k/día
  imagen_sdxl: "@cf/stabilityai/stable-diffusion-xl-base-1.0",      // Fallback
  // ── AUDIO ──
  audio_tts:   "@cf/myshell-ai/melotts",                            // Texto → Voz
  audio_stt:   "@cf/openai/whisper-large-v3-turbo",                 // Voz → Texto
  // ── SIGNIFICADO (búsqueda semántica) ──
  embeddings:  "@cf/baai/bge-base-en-v1.5",                         // texto → vector de 768 dimensiones
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
  
  // AUDIO / VOZ (texto → voz)
  if (/\b(genera|crea|hazme|haz|convierte|convierteme|pon|dame)\b.*\b(audio|voz|narración|narracion|locución|locucion|podcast|voice|mp3)\b/i.test(m) ||
      /\b(léeme|leeme|nárrame|narrame|dilo en voz|dime en voz|en voz alta|dictame|dícta)\b/i.test(m)) {
    return { tipo: "audio", confianza: "alta" };
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
//  CONVERSACIONES (memoria persistente + menú lateral)
//  Cada chat se guarda como un hilo navegable en Supabase
// ══════════════════════════════════════════════
const SUPA = () => ({ "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` });

// Anota una búsqueda o lectura en el historial (best-effort: si falla, no rompe la petición principal)
async function registrarHistorial({ usuario = "anon", tipo, titulo = "", autor = "", tema = "", fuente = "", gutenberg_id = null }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/historial_lectura`, {
      method: "POST", headers: SUPA(),
      body: JSON.stringify({ usuario, tipo, titulo, autor, tema, fuente, gutenberg_id })
    });
  } catch(e) { logger.warn("No se pudo registrar en el historial: " + e.message); }
}

// ══════════════════════════════════════════════
//  BÚSQUEDA SEMÁNTICA — búsqueda por SIGNIFICADO, no por texto exacto (gratis, Cloudflare)
// ══════════════════════════════════════════════

// Filtro de calidad (inspirado en el protocolo del dossier de Yoel): cero tolerancia a basura
function pasaFiltroCalidad(texto) {
  const t = (texto || "").trim();
  if (t.length < 30) return false;                          // demasiado corto para tener significado real
  const alfanumerico = (t.match(/[a-zA-Záéíóúñ0-9]/g) || []).length;
  if (alfanumerico / t.length < 0.4) return false;           // mayormente símbolos/basura, no texto real
  return true;
}

async function generarEmbedding(texto) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODELOS.embeddings}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: [texto.slice(0, 3000)] })   // el modelo tiene un tope de tokens por llamada
  });
  const data = await resp.json();
  const vector = data.result?.data?.[0];
  if (!vector) throw new Error("No se pudo generar el embedding: " + JSON.stringify(data.errors || data));
  return vector;
}

// Indexa un contenido para que luego se pueda encontrar por significado. Aplica el filtro de calidad primero.
async function indexarConocimiento({ contenido, origen, referencia = "" }) {
  if (!pasaFiltroCalidad(contenido)) return { ok: false, motivo: "no pasó el filtro de calidad" };
  try {
    const vector = await generarEmbedding(contenido);
    await fetch(`${SUPABASE_URL}/rest/v1/conocimiento_vectorial`, {
      method: "POST", headers: SUPA(),
      body: JSON.stringify({
        contenido: contenido.slice(0, 3000), origen, referencia,
        bytes: Buffer.byteLength(contenido, "utf8"),
        embedding: JSON.stringify(vector)   // pgvector acepta el array como texto "[0.1,0.2,...]"
      })
    });
    return { ok: true };
  } catch(e) { logger.warn("No se pudo indexar: " + e.message); return { ok: false, motivo: e.message }; }
}

// Busca por significado (no por palabra exacta) usando la función buscar_similar de Supabase
async function buscarSemantico(consulta, limite = 5, origen = null) {
  const vectorConsulta = await generarEmbedding(consulta);
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/buscar_similar`, {
    method: "POST", headers: SUPA(),
    body: JSON.stringify({ query_embedding: JSON.stringify(vectorConsulta), limite, filtro_origen: origen })
  });
  return await resp.json();
}

// Rango militar del sistema, según el volumen total de conocimiento indexado (idea del dossier de Yoel)
function calcularRangoSistema(totalBytes) {
  const kb = totalBytes / 1024;
  let rango, minKB, maxKB, minPct, maxPct, estrellas;
  if (kb <= 500)        { rango = "Recluta / Soldado Raso"; minKB = 0;     maxKB = 500;   minPct = 0;   maxPct = 100;  estrellas = 1; }
  else if (kb <= 2048)  { rango = "Cabo / Sargento";        minKB = 501;   maxKB = 2048;  minPct = 101; maxPct = 300;  estrellas = 2; }
  else if (kb <= 10240) { rango = "Oficial / Teniente";     minKB = 2100;  maxKB = 10240; minPct = 301; maxPct = 600;  estrellas = 3; }
  else                  { rango = "Comandante / General";   minKB = 10100; maxKB = Math.max(kb, 10100) * 1.4; minPct = 601; maxPct = 1000; estrellas = 4; }
  const progreso = Math.min(1, Math.max(0, (kb - minKB) / ((maxKB - minKB) || 1)));
  const porcentaje = Math.round(minPct + progreso * (maxPct - minPct));
  return { rango, estrellas, porcentaje: Math.min(porcentaje, 1000), kb: Math.round(kb), mb: (kb / 1024).toFixed(2) };
}

app.post("/buscar-semantico", async (req, res) => {
  const { q, limite = 5, origen = null } = req.body || {};
  if (!q) return res.status(400).json({ error: "Falta la consulta" });
  try {
    const resultados = await buscarSemantico(q, limite, origen);
    res.json({ ok: true, resultados });
  } catch(e) { logger.error("/buscar-semantico: " + e.message); res.status(500).json({ error: e.message }); }
});

app.get("/rango-sistema", async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/conocimiento_vectorial?select=bytes`, { headers: SUPA() });
    const filas = await r.json();
    const totalBytes = (filas || []).reduce((sum, f) => sum + (f.bytes || 0), 0);
    res.json({ ok: true, ...calcularRangoSistema(totalBytes), items_indexados: (filas || []).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rango de CADA agente por separado, según cuánto ha trabajado (mensajes/bytes que ha procesado)
app.get("/rango-agentes", async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bytes_por_agente`, { method: "POST", headers: SUPA(), body: "{}" });
    const filas = await r.json();
    const porAgente = {};
    (Array.isArray(filas) ? filas : []).forEach(f => { porAgente[f.agente] = f; });

    const agentes = Object.keys(AGENTES)
      .filter(id => !["supervisor", "corrector", "verificador", "rastreador"].includes(id)) // internos, no de cara al usuario
      .map(id => {
        const fila = porAgente[id] || { total_bytes: 0, total_mensajes: 0 };
        const r = calcularRangoSistema(Number(fila.total_bytes) || 0);
        return { id, nombre: AGENTES[id].nombre, mensajes: Number(fila.total_mensajes) || 0, ...r };
      });
    res.json({ ok: true, agentes });
  } catch(e) { logger.error("/rango-agentes: " + e.message); res.status(500).json({ error: e.message }); }
});

// Crear una conversación nueva → devuelve el registro (con su id)
async function crearConversacion(usuario, titulo, agente) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/conversaciones`, {
    method: "POST",
    headers: { ...SUPA(), "Prefer": "return=representation" },
    body: JSON.stringify({ usuario: usuario || "yoel", titulo: (titulo || "Nueva conversación").slice(0, 80), agente: agente || "general" })
  });
  const data = await resp.json();
  return Array.isArray(data) ? data[0] : data;
}

// Listar conversaciones de un usuario (lo que se ve en el menú lateral)
async function listarConversaciones(usuario) {
  const filtro = usuario ? `&usuario=eq.${encodeURIComponent(usuario)}` : "";
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/conversaciones?select=id,titulo,agente,creada_en,actualizada_en&order=actualizada_en.desc&limit=100${filtro}`, { headers: SUPA() });
  return await resp.json();
}

// Cargar una conversación completa con sus mensajes en orden
async function cargarConversacion(id) {
  const [c, m] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/conversaciones?id=eq.${id}&select=*`, { headers: SUPA() }),
    fetch(`${SUPABASE_URL}/rest/v1/mensajes?conversacion_id=eq.${id}&select=*&order=creado_en.asc`, { headers: SUPA() })
  ]);
  const conv = await c.json();
  const mensajes = await m.json();
  return { conversacion: Array.isArray(conv) ? conv[0] : conv, mensajes };
}

// Guardar un mensaje dentro de una conversación y refrescar su fecha (para que suba en el menú)
async function guardarMensaje(conversacionId, rol, contenido, artefactos, pasos) {
  await fetch(`${SUPABASE_URL}/rest/v1/mensajes`, {
    method: "POST", headers: SUPA(),
    body: JSON.stringify({ conversacion_id: conversacionId, rol, contenido: contenido || "", artefactos: artefactos || null, pasos: pasos || null })
  });
  await fetch(`${SUPABASE_URL}/rest/v1/conversaciones?id=eq.${conversacionId}`, {
    method: "PATCH", headers: SUPA(),
    body: JSON.stringify({ actualizada_en: new Date().toISOString() })
  });
}

// Renombrar una conversación
async function renombrarConversacion(id, titulo) {
  await fetch(`${SUPABASE_URL}/rest/v1/conversaciones?id=eq.${id}`, {
    method: "PATCH", headers: SUPA(), body: JSON.stringify({ titulo: (titulo || "").slice(0, 80) })
  });
}

// Borrar una conversación (sus mensajes se borran solos por el ON DELETE CASCADE)
async function borrarConversacion(id) {
  await fetch(`${SUPABASE_URL}/rest/v1/conversaciones?id=eq.${id}`, { method: "DELETE", headers: SUPA() });
}

// ══════════════════════════════════════════════
//  GENERADORES (usados por el orquestador)
// ══════════════════════════════════════════════
async function generarImagen(prompt) {
  // Optimizar prompt con FUNDORA VISION (el prompt óptimo para modelos de imagen va en inglés)
  let promptOpt = prompt;
  try {
    promptOpt = await llamarCF(AGENTES.director.modelo, [
      { role: "system", content: AGENTES.director.system + " Responde SOLO con el prompt optimizado EN INGLÉS para un modelo de difusión, máximo 200 caracteres. Sin explicaciones." },
      { role: "user", content: "Optimiza para imagen de alta calidad: " + prompt }
    ], 200);
  } catch(e) {}

  // ── INTENTO 1: FLUX.1 Schnell (mejor calidad, más rápido, ~100k/día) ──
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODELOS.imagen}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptOpt, steps: 6 }) // FLUX Schnell: máx 8 pasos
    });
    const data = await resp.json();
    if (data.success && data.result?.image) {
      // FLUX devuelve la imagen como base64 JPEG dentro de result.image
      return { imagen: "data:image/jpeg;base64," + data.result.image, prompt_usado: promptOpt, modelo: "flux-1-schnell" };
    }
    logger.warn("FLUX no devolvió imagen, usando SDXL fallback");
  } catch(e) { logger.warn("FLUX falló: " + e.message); }

  // ── INTENTO 2: SDXL (fallback confiable) ──
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODELOS.imagen_sdxl}`;
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
    base64 = data.result.image;
  } else {
    const buffer = await resp.arrayBuffer();
    base64 = Buffer.from(buffer).toString("base64");
  }
  return { imagen: "data:image/png;base64," + base64, prompt_usado: promptOpt, modelo: "sdxl-fallback" };
}

// ── AUDIO: Texto → Voz (MeloTTS) ──
// Voz de Google Cloud (WaveNet) — mucho más natural que MeloTTS, gratis hasta 1M caracteres/mes
async function generarAudioGoogle(texto, lang = "ES") {
  const textoLimpio = texto.replace(/[#*`_>]/g, "").slice(0, 5000).trim(); // Google admite textos largos, sin el tope de 500 de MeloTTS
  const esIngles = /^(en|en-us|english|ingles|inglés)$/i.test((lang || "").toLowerCase());
  const languageCode = esIngles ? "en-US" : "es-US";
  const voiceName = esIngles ? "en-US-Wavenet-D" : "es-US-Wavenet-A";

  const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: textoLimpio },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "MP3" }
    })
  });
  const data = await resp.json();
  if (!data.audioContent) throw new Error("Google TTS falló: " + JSON.stringify(data.error || data));
  return { audio: "data:audio/mpeg;base64," + data.audioContent, texto: textoLimpio, idioma: esIngles ? "en" : "ES", motor: "google" };
}

// Voz de MeloTTS (Cloudflare) — más robótica, pero gratis sin necesitar clave adicional. Respaldo si Google falla.
async function generarAudioMeloTTS(texto, lang = "ES") {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODELOS.audio_tts}`;
  // Limpiar el texto: MeloTTS no maneja bien textos muy largos o con muchos símbolos
  const textoLimpio = texto.replace(/[#*`_>]/g, "").slice(0, 500).trim();

  // MeloTTS de Cloudflare exige códigos EXACTOS e inconsistentes:
  // español = "ES" (mayúscula), inglés = "en" (minúscula), francés = "FR", etc.
  // Este mapa normaliza cualquier forma de escribir el idioma al código correcto.
  const MAPA_IDIOMA = {
    es: "ES", "es-es": "ES", "es-mx": "ES", espanol: "ES", "español": "ES", spanish: "ES",
    en: "en", "en-us": "en", english: "en", ingles: "en", "inglés": "en",
    fr: "FR", french: "FR", "francés": "FR",
    zh: "ZH", jp: "JP", ja: "JP", kr: "KR", ko: "KR"
  };
  const codigo = MAPA_IDIOMA[(lang || "ES").toLowerCase()] || "ES";

  // Intentar con el idioma pedido; si Cloudflare lo rechaza, caer a inglés
  const idiomas = [codigo, "en"].filter((v, i, a) => a.indexOf(v) === i);
  let ultimoError = "";
  for (const idioma of idiomas) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: textoLimpio, lang: idioma })
      });
      const data = await resp.json();
      if (data.success && data.result?.audio) {
        return { audio: "data:audio/mpeg;base64," + data.result.audio, texto: textoLimpio, idioma, motor: "melotts" };
      }
      ultimoError = JSON.stringify(data.errors || data);
    } catch(e) { ultimoError = e.message; }
  }
  throw new Error("MeloTTS falló: " + ultimoError);
}

// Punto de entrada único que usa el resto del código: intenta Google (natural) primero,
// y si no hay clave configurada o falla, cae a MeloTTS (robótica pero siempre disponible).
async function generarAudio(texto, lang = "ES") {
  if (GOOGLE_TTS_API_KEY) {
    try { return await generarAudioGoogle(texto, lang); }
    catch(e) { logger.warn("Google TTS falló, usando MeloTTS de respaldo: " + e.message); }
  }
  return await generarAudioMeloTTS(texto, lang);
}

// ── AUDIO: Voz → Texto (Whisper) ──
async function transcribirAudio(audioBuffer) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODELOS.audio_stt}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ audio: Array.from(new Uint8Array(audioBuffer)) })
  });
  const data = await resp.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors));
  return { texto: data.result.text, palabras: data.result.word_count };
}

async function generarVideo(prompt, escenas = 3) {
  // Entre 2 y 4 escenas: suficiente para narrar, sin saturar el teléfono ni engordar el video
  escenas = Math.max(2, Math.min(parseInt(escenas) || 3, 4));

  // ── 1) Prompt base cinematográfico: da coherencia visual entre todas las escenas ──
  let promptBase = prompt;
  try {
    promptBase = await llamarCF(AGENTES.director.modelo, [
      { role: "system", content: AGENTES.director.system + " Responde SOLO con un prompt EN INGLÉS para una escena cinematográfica, máximo 150 caracteres. Sin explicaciones." },
      { role: "user", content: "Escena para video: " + prompt }
    ], 150);
  } catch(e) {}

  // Cada escena usa un plano distinto → sensación de montaje de cine, no de foto repetida
  const planos = ["cinematic establishing wide shot", "cinematic medium shot", "cinematic close-up detail", "cinematic dramatic hero shot"];

  // ── 2) Generar una imagen por escena con FLUX (gratis) y guardarla en disco ──
  const rutas = [];
  for (let i = 0; i < escenas; i++) {
    const fp = `${promptBase}, ${planos[i % planos.length]}, consistent characters and lighting, film grain, 35mm, high detail`;
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODELOS.imagen}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fp, steps: 6 })
      });
      const d = await resp.json();
      if (d.success && d.result?.image) {
        const rp = path.join(TMP_DIR, `vframe_${i}.jpg`);
        fs.writeFileSync(rp, Buffer.from(d.result.image, "base64"));
        rutas.push(rp);
      }
    } catch(e) { logger.warn(`Escena ${i} falló: ${e.message}`); }
  }
  if (rutas.length === 0) throw new Error("No se pudo generar ninguna escena");

  const salida = path.join(TMP_DIR, "vout.mp4");
  const FPS = 24, DUR = 3.0, CF = 0.6;          // 3 s por escena, fundidos de 0,6 s
  const NF = Math.round(DUR * FPS);              // frames por escena (72)

  const limpiarImgs = () => { for (const r of rutas) { try { fs.unlinkSync(r); } catch(e){} } };
  const devolver = () => {
    const b64 = fs.readFileSync(salida).toString("base64");
    try { fs.unlinkSync(salida); } catch(e){}
    limpiarImgs();
    return { video: "data:video/mp4;base64," + b64, escenas: rutas.length, modelo: "flux + cámara cinematográfica (ffmpeg)" };
  };

  // A dónde "viaja" el zoom en cada escena → simula un movimiento de cámara distinto cada vez
  const focos = [
    "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'", // acercamiento al centro
    "x='0':y='0'",                                 // deriva hacia arriba-izquierda
    "x='iw-(iw/zoom)':y='ih-(ih/zoom)'",           // deriva hacia abajo-derecha
    "x='iw-(iw/zoom)':y='0'"                        // deriva hacia arriba-derecha
  ];
  // Convierte UNA imagen en un clip con zoom lento de cámara (el efecto "Ken Burns" del cine)
  const hacerClip = (imgPath, idx, clipPath) => {
    const foco = focos[idx % focos.length];
    // scale+crop deja margen extra para que el zoom no pixele; zoompan crea el movimiento suave
    const vf = `scale=1440:1440:force_original_aspect_ratio=increase,crop=1440:1440,zoompan=z='min(zoom+0.0011,1.32)':d=${NF}:${foco}:s=720x720:fps=${FPS},setsar=1`;
    execSync(`ffmpeg -y -i "${imgPath}" -vf "${vf}" -c:v libx264 -pix_fmt yuv420p -r ${FPS} -an "${clipPath}" 2>/dev/null`);
  };

  // ── 3) INTENTO A (lo más bonito): clip con movimiento por escena + fundidos encadenados ──
  try {
    const clips = [];
    for (let i = 0; i < rutas.length; i++) {
      const cp = path.join(TMP_DIR, `vclip_${i}.mp4`);
      hacerClip(rutas[i], i, cp);
      clips.push(cp);
    }
    const borrarClips = () => { for (const c of clips) { try { fs.unlinkSync(c); } catch(e){} } };

    if (clips.length === 1) {
      fs.copyFileSync(clips[0], salida); borrarClips(); return devolver();
    }
    // Encadenar con xfade: el fundido nº k arranca en k*(DUR-CF) segundos
    const inputs = clips.map(c => `-i "${c}"`).join(" ");
    let fc = "", prev = "[0]";
    for (let k = 1; k < clips.length; k++) {
      const off = (k * (DUR - CF)).toFixed(2);
      const out = (k === clips.length - 1) ? "[out]" : `[a${k}]`;
      fc += `${prev}[${k}]xfade=transition=fade:duration=${CF}:offset=${off}${out};`;
      prev = `[a${k}]`;
    }
    fc = fc.replace(/;$/, "");
    execSync(`ffmpeg -y ${inputs} -filter_complex "${fc}" -map "[out]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${salida}" 2>/dev/null`);
    borrarClips();
    return devolver();
  } catch(eA) { logger.warn("Video A (xfade) falló: " + eA.message); }

  // ── 4) INTENTO B (respaldo): mismos clips con movimiento, pero unidos con corte seco ──
  try {
    const clips = [];
    for (let i = 0; i < rutas.length; i++) {
      const cp = path.join(TMP_DIR, `vclip_${i}.mp4`);
      try { hacerClip(rutas[i], i, cp); clips.push(cp); } catch(e){}
    }
    if (clips.length >= 1) {
      const lista = path.join(TMP_DIR, "vlist.txt");
      fs.writeFileSync(lista, clips.map(c => `file '${c}'`).join("\n"));
      execSync(`ffmpeg -y -f concat -safe 0 -i "${lista}" -c copy "${salida}" 2>/dev/null`);
      for (const c of clips) { try { fs.unlinkSync(c); } catch(e){} }
      try { fs.unlinkSync(lista); } catch(e){}
      return devolver();
    }
  } catch(eB) { logger.warn("Video B (concat) falló: " + eB.message); }

  // ── 5) INTENTO C (respaldo del respaldo): método antiguo, frames pegados ──
  try {
    const patron = path.join(TMP_DIR, "vframe_%d.jpg");
    execSync(`ffmpeg -y -framerate 1 -i "${patron}" -c:v libx264 -pix_fmt yuv420p -vf "scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2" "${salida}" 2>/dev/null`);
    return devolver();
  } catch(eC) { logger.warn("Video C (slideshow) falló: " + eC.message); }

  // ── 6) Último recurso: devolver las escenas como imágenes sueltas ──
  const imgs = rutas.map(r => "data:image/jpeg;base64," + fs.readFileSync(r).toString("base64"));
  limpiarImgs();
  return { imagenes: imgs, escenas: imgs.length, nota: "Escenas individuales (ffmpeg no disponible)" };
}

async function generarPDF(titulo, contenido, portadaBase64 = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => {
      const b64 = Buffer.concat(chunks).toString("base64");
      resolve({ pdf: "data:application/pdf;base64," + b64, nombre: titulo + ".pdf" });
    });
    doc.on("error", reject);
    // Si hay portada, va primero a página completa (es lo que "vende" al abrir el archivo)
    if (portadaBase64) {
      try {
        const buf = Buffer.from(portadaBase64.replace(/^data:image\/[^;]+;base64,/, ""), "base64");
        doc.image(buf, 0, 0, { width: doc.page.width, height: doc.page.height });
        doc.addPage();
      } catch(e) { logger.warn("No se pudo insertar la portada en el PDF: " + e.message); }
    }
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
//  MOTOR DE HERRAMIENTAS (Function Calling / ReAct)
//  El agente razona, elige herramientas y las encadena
// ══════════════════════════════════════════════
const DIR_GENERADOS = path.join(SAFE_ROOT, "generados");
try { if (!fs.existsSync(DIR_GENERADOS)) fs.mkdirSync(DIR_GENERADOS, { recursive: true }); } catch(e) {}

// Guarda una creación multimedia (imagen/video/audio/pdf) como archivo REAL en disco,
// para que persista y se vea en la Biblioteca aunque el usuario recargue o salga.
// Devuelve la URL pública relativa (/generados/xxx) o null si no se pudo archivar.
function archivarCreacion(art) {
  try {
    const campo = art.tipo;                        // "imagen" | "audio" | "video" | "pdf"
    let dataUrl = art[campo];
    // Si el video cayó al respaldo de frames sueltos, guardamos al menos la primera imagen
    if (!dataUrl && art.tipo === "video" && Array.isArray(art.imagenes) && art.imagenes.length) {
      dataUrl = art.imagenes[0];
    }
    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    // Separar el tipo MIME y el contenido base64 del data URL
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) return null;
    const mime = m[1], b64 = m[2];
    const extPorMime = { "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "video/mp4":"mp4", "audio/mpeg":"mp3", "audio/mp3":"mp3", "audio/wav":"wav", "application/pdf":"pdf" };
    const ext = extPorMime[mime] || (art.tipo === "imagen" ? "jpg" : art.tipo === "video" ? "mp4" : art.tipo === "audio" ? "mp3" : "bin");
    // Nombre único: fecha + tipo + azar → nunca se pisan
    const nombre = `${Date.now()}_${art.tipo}_${Math.random().toString(36).slice(2,7)}.${ext}`;
    fs.writeFileSync(path.join(DIR_GENERADOS, nombre), Buffer.from(b64, "base64"));
    return "/generados/" + nombre;
  } catch(e) { logger.warn("No se pudo archivar la creación: " + e.message); return null; }
}

// ══════════════════════════════════════════════
//  VISIÓN — le da "ojos" al agente con Gemini (gratis, Google AI Studio)
// ══════════════════════════════════════════════
async function analizarImagen(urlImagen, pregunta = "Describe esta imagen con detalle: qué se ve, colores, estilo, calidad, y qué mejorarías.") {
  if (!GEMINI_API_KEY) throw new Error("Falta configurar GEMINI_API_KEY para poder ver imágenes");
  let base64Img, mimeType = "image/jpeg";

  if (urlImagen.startsWith("/generados/")) {
    // Viene del Stock: la leemos directo del disco, sin rodeos por red
    const rutaLocal = path.join(DIR_GENERADOS, path.basename(urlImagen));
    if (!fs.existsSync(rutaLocal)) throw new Error("Esa imagen no está en el Stock");
    base64Img = fs.readFileSync(rutaLocal).toString("base64");
    const ext = path.extname(rutaLocal).toLowerCase();
    mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  } else if (urlImagen.startsWith("data:image/")) {
    const m = urlImagen.match(/^data:(image\/[^;]+);base64,(.*)$/s);
    if (!m) throw new Error("Formato de imagen no reconocido");
    mimeType = m[1]; base64Img = m[2];
  } else {
    throw new Error("Solo puedo mirar imágenes del Stock (/generados/...) o en base64");
  }

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: pregunta }, { inline_data: { mime_type: mimeType, data: base64Img } }] }]
    })
  });
  const data = await resp.json();
  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error("Gemini no devolvió análisis: " + JSON.stringify(data.error || data));
  return texto;
}

const HERRAMIENTAS = {
  generar_imagen: {
    def: { type: "function", function: {
      name: "generar_imagen",
      description: "Genera una imagen desde una descripción. Úsala para logos, fotos, banners, ilustraciones, avatares.",
      parameters: { type: "object", properties: { prompt: { type: "string", description: "Descripción detallada de la imagen" } }, required: ["prompt"] }
    }},
    run: async (a) => { const r = await generarImagen(a.prompt); return { ok: true, tipo: "imagen", ...r }; }
  },
  mirar_imagen: {
    def: { type: "function", function: {
      name: "mirar_imagen",
      description: "Analiza de verdad una imagen ya generada (o un fotograma de un video) para poder opinar sobre lo que se ve: colores, estilo, calidad, composición. Úsala después de generar_imagen o generar_video cuando el usuario pregunte tu opinión sobre el resultado, o quieras comentarlo con criterio real en vez de adivinar por el prompt.",
      parameters: { type: "object", properties: {
        url: { type: "string", description: "La URL /generados/... de la imagen (la que devolvió generar_imagen)" },
        pregunta: { type: "string", description: "Qué quieres saber sobre la imagen (opcional, por defecto pide una descripción general)" }
      }, required: ["url"] }
    }},
    run: async (a) => {
      try { const analisis = await analizarImagen(a.url, a.pregunta); return { ok: true, tipo: "analisis", analisis }; }
      catch(e) { return { ok: false, error: e.message }; }
    }
  },
  generar_audio: {
    def: { type: "function", function: {
      name: "generar_audio",
      description: "Convierte texto en voz (audio MP3). Úsala para narraciones, locuciones, podcasts.",
      parameters: { type: "object", properties: { texto: { type: "string", description: "Texto a narrar" } }, required: ["texto"] }
    }},
    run: async (a) => { const r = await generarAudio(a.texto, "es"); return { ok: true, tipo: "audio", ...r }; }
  },
  generar_video: {
    def: { type: "function", function: {
      name: "generar_video",
      description: "Genera un video corto desde una descripción (secuencia de frames a MP4).",
      parameters: { type: "object", properties: { prompt: { type: "string", description: "Descripción de la escena" }, frames: { type: "number", description: "Número de frames (3-8)" } }, required: ["prompt"] }
    }},
    run: async (a) => { const r = await generarVideo(a.prompt, a.frames || 5); return { ok: true, tipo: "video", ...r }; }
  },
  generar_pdf: {
    def: { type: "function", function: {
      name: "generar_pdf",
      description: "Genera un documento PDF con un título y contenido.",
      parameters: { type: "object", properties: { titulo: { type: "string" }, contenido: { type: "string", description: "Texto completo del documento" } }, required: ["titulo", "contenido"] }
    }},
    run: async (a) => { const r = await generarPDF(a.titulo, a.contenido); return { ok: true, tipo: "pdf", ...r }; }
  },
  escribir_codigo: {
    def: { type: "function", function: {
      name: "escribir_codigo",
      description: "Escribe código de programación según una descripción. Devuelve el código como texto.",
      parameters: { type: "object", properties: { descripcion: { type: "string", description: "Qué debe hacer el código" }, lenguaje: { type: "string", description: "javascript, python, etc." } }, required: ["descripcion"] }
    }},
    run: async (a) => {
      const codigo = await llamarCF(AGENTES.programador.modelo, [
        { role: "system", content: AGENTES.programador.system + " Responde SOLO con el código, sin explicaciones fuera de comentarios." },
        { role: "user", content: `Lenguaje: ${a.lenguaje || "javascript"}. Tarea: ${a.descripcion}` }
      ], 2000);
      return { ok: true, tipo: "codigo", codigo, lenguaje: a.lenguaje || "javascript" };
    }
  },
  guardar_archivo: {
    def: { type: "function", function: {
      name: "guardar_archivo",
      description: "Guarda contenido de texto en un archivo dentro de la carpeta de generados. Úsala para persistir código o documentos.",
      parameters: { type: "object", properties: { nombre: { type: "string", description: "Nombre del archivo, ej: app.js" }, contenido: { type: "string" } }, required: ["nombre", "contenido"] }
    }},
    run: async (a) => {
      const nombreSeguro = path.basename(a.nombre); // evita rutas maliciosas (../)
      const ruta = path.join(DIR_GENERADOS, nombreSeguro);
      fs.writeFileSync(ruta, a.contenido);
      return { ok: true, tipo: "archivo", nombre: nombreSeguro, ruta, bytes: a.contenido.length };
    }
  },
  leer_archivo: {
    def: { type: "function", function: {
      name: "leer_archivo",
      description: "Lee el contenido de un archivo de la carpeta de generados.",
      parameters: { type: "object", properties: { nombre: { type: "string" } }, required: ["nombre"] }
    }},
    run: async (a) => {
      const ruta = path.join(DIR_GENERADOS, path.basename(a.nombre));
      if (!fs.existsSync(ruta)) return { ok: false, error: "Archivo no existe" };
      return { ok: true, contenido: fs.readFileSync(ruta, "utf8") };
    }
  },
  listar_archivos: {
    def: { type: "function", function: {
      name: "listar_archivos",
      description: "Lista los archivos guardados en la carpeta de generados.",
      parameters: { type: "object", properties: {} }
    }},
    run: async () => {
      const archivos = fs.existsSync(DIR_GENERADOS) ? fs.readdirSync(DIR_GENERADOS) : [];
      return { ok: true, archivos, total: archivos.length };
    }
  },
  ejecutar_comando: {
    def: { type: "function", function: {
      name: "ejecutar_comando",
      description: "Ejecuta un comando de terminal en la carpeta de trabajo (Termux). Úsala para tareas de sistema, git, npm, etc.",
      parameters: { type: "object", properties: { comando: { type: "string" } }, required: ["comando"] }
    }},
    run: async (a) => {
      const cmd = a.comando || "";
      // Protecciones de seguridad
      if (/rm\s+-rf\s+\/|sudo|chmod\s+777|mkfs|:\(\)\{|dd\s+if=/i.test(cmd)) {
        return { ok: false, error: "Comando bloqueado por seguridad" };
      }
      return await new Promise(resolve => {
        exec(cmd, { cwd: SAFE_ROOT, timeout: 20000, maxBuffer: 1024*500 }, (error, stdout, stderr) => {
          resolve({ ok: !error, stdout: (stdout||"").slice(0,3000), stderr: (stderr||"").slice(0,1000), error: error?.message || null });
        });
      });
    }
  }
};

// Loop ReAct: el modelo razona → usa herramientas → ve resultados → continúa
// Red de seguridad: si el modelo devuelve el JSON interno ({"accion":...,"texto":"..."})
// en vez de texto natural, extraemos SOLO el campo legible para que el usuario no vea las tripas.
function limpiarRespuesta(texto) {
  if (typeof texto !== "string") return texto;
  let t = texto.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  if (t.startsWith("{") && /"texto"\s*:/.test(t)) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o.texto === "string" && o.texto.trim()) return o.texto.trim();
    } catch(e) {}
  }
  return texto;
}

async function ejecutarConHerramientas(mensaje, agenteId = "general", maxIteraciones = 6, historialPrevio = []) {
  const config = AGENTES[agenteId] || AGENTES.general;
  // El general nació como orquestador JSON seco; en el motor le damos un carácter conversacional y cálido.
  const caracter = (agenteId === "general")
    ? `Eres FUNDORA AI, el asistente central de Fundora Agency y la mano derecha de Yoel Fundora. Hablas como un colega cercano y con criterio: cálido, natural, profesional, con iniciativa. CONVERSAS DE VERDAD — nunca sueltas frases de robot como "logo generado" o "tarea completada". Cuando haces algo, lo comentas con naturalidad y propones el siguiente paso. Cuando el usuario reacciona (algo no le gustó, quiere cambios), respondes con empatía y le preguntas lo que necesites para acertar: estilo, colores, tono, referencias. Tienes buen gusto y recuerdas el hilo de la conversación. Conoces el ecosistema de Yoel: PAS (marketplace Miami–TCI), BetGroup Pro (apuestas), Nexo (marketplace cubano).`
    : config.system;
  const historial = [
    { role: "system", content: caracter + `

TIENES HERRAMIENTAS REALES que ejecutan acciones de verdad (generar imagen/audio/video/PDF, mirar_imagen para ver de verdad lo que generas, escribir_codigo, guardar_archivo, leer/listar archivos, ejecutar_comando).

REGLAS ABSOLUTAS DE USO DE HERRAMIENTAS:
1. NUNCA anuncies ni describas que vas a usar una herramienta. NO escribas frases como "ahora procederé a...", "utilizaremos la función...", "vamos a guardar...". En lugar de decirlo, HAZLO: emite la llamada a la herramienta directamente.
2. Si la tarea necesita varios pasos (ej: escribir código Y guardarlo en un archivo), ejecuta las herramientas UNA TRAS OTRA. Después de escribir_codigo, si hay que guardarlo, llama a guardar_archivo INMEDIATAMENTE en tu siguiente turno.
3. NO te detengas a mitad de una tarea. Sigue llamando herramientas hasta que TODO esté hecho.
3b. YA PUEDES VER: si generaste una imagen o un video y el usuario pregunta tu opinión, cómo quedó, o pide que lo describas/critiques — usa mirar_imagen con la URL que te devolvió generar_imagen o generar_video ANTES de responder. No opines a ciegas basándote solo en el prompt que escribiste; mira de verdad y comenta lo que realmente ves.
4. Cuando la tarea esté completa, responde con NATURALIDAD Y CALIDEZ, como una persona real conversando: comenta lo que hiciste, aporta una opinión o una sugerencia útil, y si tiene sentido pregunta el siguiente paso. JAMÁS respondas con frases secas de robot ("logo generado", "tarea completada", "vídeo generado para X") — eso suena a alguien dormido. Ponle vida, criterio y cercanía.
5. FORMATO DE TU RESPUESTA FINAL: SIEMPRE texto plano, natural y directo, como hablaría una persona. NUNCA respondas en JSON ni con estructuras tipo {"accion":...} o {"texto":...} — eso son tripas internas que el usuario JAMÁS debe ver. IDIOMA: responde SIEMPRE en el MISMO idioma en que te escribe o te habla el usuario (español, inglés, o el que sea) — nunca cambies de idioma por tu cuenta.
6. CONTEXTO: recuerdas los mensajes anteriores de esta conversación (están más arriba en el hilo). Si el usuario dice "la imagen", "eso", "explícamelo", "¿qué significa?", "el archivo anterior" y similares, se refiere a algo que YA ocurrió antes; NO lo trates como un pedido nuevo ni lo generes de cero — responde sobre lo que ya existe en el hilo.` },
    ...historialPrevio,
    { role: "user", content: mensaje }
  ];

  // ── Salvavidas contra "audios locos": una charla simple (saludo, gracias, ok…) NUNCA necesita
  // herramientas. Si se lo ofrecemos igual, el modelo a veces alucina una llamada (ej. generar audio
  // de la nada ante un simple "Hola"). Para esos casos respondemos SIN pasarle el toolsSchema —
  // así es imposible que invente una acción, porque la opción ni siquiera está sobre la mesa.
  const esCharlaSimple = /^(hola+|hi|hello+|hey+|buen[oa]s?\s*(d[ií]as?|tardes?|noches?)?|qu[eé]\s*tal|c[oó]mo\s*est[aá]s?|gracias+|ok(ay)?|vale|genial|perfecto|entendido|listo)[\s!.¡¿?]*$/i;
  if (esCharlaSimple.test(mensaje.trim())) {
    try {
      const texto = await llamarCF(config.modelo, historial, 300);
      return { respuesta: limpiarRespuesta(texto || "¡Hola! ¿En qué te ayudo hoy?"), pasos: [], artefactos: [] };
    } catch(e) { /* si falla, seguimos al camino normal con herramientas como respaldo */ }
  }

  const toolsSchema = Object.values(HERRAMIENTAS).map(h => h.def);
  const artefactos = [];   // imágenes, audios, videos, pdfs para el frontend
  const pasos = [];        // traza de lo que hizo el agente
  let respuestaFinal = "";
  let empujado = false;    // salvavidas: solo empujamos una vez si el modelo narra en vez de actuar

  for (let iter = 0; iter < maxIteraciones; iter++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${config.modelo}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: historial, tools: toolsSchema, max_tokens: 1500 })
    });
    const data = await resp.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors));

    const result = data.result || {};
    const toolCalls = result.tool_calls || [];

    // Sin herramientas → ¿respuesta final o narró en vez de actuar?
    if (!toolCalls.length) {
      // Robustez: a veces Cloudflare devuelve response como objeto → lo pasamos a texto
      let texto = result.response;
      if (texto && typeof texto === "object") texto = texto.response || texto.text || JSON.stringify(texto);
      texto = (texto || "").toString();
      // Salvavidas: si el modelo DESCRIBE una herramienta en vez de llamarla, lo empujamos una vez
      const nombresHerr = Object.keys(HERRAMIENTAS).join("|");
      const narraIntencion = new RegExp(`(${nombresHerr})|procede|procederé|vamos a (guardar|crear|ejecutar)|utilizar[eé]|utilizaremos|voy a (usar|guardar|crear)`, "i").test(texto);
      if (narraIntencion && !empujado && iter < maxIteraciones - 1) {
        empujado = true;
        historial.push({ role: "assistant", content: texto });
        historial.push({ role: "user", content: "No describas la herramienta: LLÁMALA ahora mismo para completar la tarea. Ejecuta la acción, no la anuncies." });
        continue; // darle otra vuelta para que ejecute de verdad
      }
      respuestaFinal = texto || "Tarea completada.";
      break;
    }

    // Normalizar los tool_calls al FORMATO OpenAI COMPLETO que Cloudflare exige al reenviar
    // (Cloudflare los entrega como {name, arguments} pero los pide de vuelta con id + type + function)
    const toolCallsFmt = toolCalls.map((tc, i) => {
      const nombre = tc.name || tc.function?.name;
      let args = tc.arguments ?? tc.function?.arguments ?? {};
      const argsStr = typeof args === "string" ? args : JSON.stringify(args); // arguments debe ir como TEXTO
      return {
        id: tc.id || `call_${Date.now()}_${i}`,   // id requerido (lo generamos si no viene)
        type: "function",                          // type requerido
        function: { name: nombre, arguments: argsStr }
      };
    });

    // Registrar la decisión del asistente con el formato correcto
    historial.push({ role: "assistant", content: result.response || "", tool_calls: toolCallsFmt });

    // Ejecutar cada herramienta pedida
    for (const tcf of toolCallsFmt) {
      const nombre = tcf.function.name;
      let args = tcf.function.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch(e) { args = {}; } }

      const herramienta = HERRAMIENTAS[nombre];
      let resultado;
      if (herramienta) {
        try { resultado = await herramienta.run(args); }
        catch(e) { resultado = { ok: false, error: e.message }; }
      } else {
        resultado = { ok: false, error: "Herramienta desconocida: " + nombre };
      }

      pasos.push({ herramienta: nombre, argumentos: args, ok: resultado.ok });

      // Guardar artefactos multimedia para el frontend
      if (resultado.tipo && ["imagen","audio","video","pdf"].includes(resultado.tipo)) {
        const url = archivarCreacion(resultado);   // lo escribe en disco para que quede en la Biblioteca
        if (url) resultado.url = url;               // URL persistente (sobrevive a recargas)
        artefactos.push(resultado);
      }

      // Devolver al modelo una versión ligera (sin base64 gigante que satura el contexto)
      const liviano = { ...resultado };
      ["imagen","audio","video","pdf"].forEach(k => { if (liviano[k]) liviano[k] = `[${k} generado correctamente]`; });
      // El mensaje 'tool' necesita tool_call_id que coincida con el id del tool_call
      historial.push({ role: "tool", tool_call_id: tcf.id, name: nombre, content: JSON.stringify(liviano).slice(0, 2000) });
    }
  }

  if (!respuestaFinal) respuestaFinal = "Tarea procesada (se alcanzó el límite de pasos).";
  if (typeof respuestaFinal !== "string") respuestaFinal = JSON.stringify(respuestaFinal);
  respuestaFinal = limpiarRespuesta(respuestaFinal);
  return { respuesta: respuestaFinal, pasos, artefactos };
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
// Sirve las creaciones guardadas (imágenes/videos/audios/pdfs) para la Biblioteca
app.use("/generados", express.static(DIR_GENERADOS));

// ══════════════════════════════════════════════
//  ENDPOINTS PRINCIPALES
// ══════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    nombre: "FUNDORA AGENCY AI",
    version: "4.2",
    agentes: Object.keys(AGENTES).length,
    uptime_horas: (process.uptime() / 3600).toFixed(2),
    capacidades: ["chat", "agente-herramientas", "imagen", "video", "audio", "pdf", "codigo", "terminal"],
    motores: {
      imagen: "FLUX.1 Schnell (fallback SDXL)",
      audio: "MeloTTS + Whisper v3 Turbo",
      video: "FLUX frames + ffmpeg"
    },
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
          
        } else if (intencion.tipo === "audio") {
          // Extraer el texto a narrar (quitar la orden inicial)
          let textoNarrar = mensaje.replace(/^(genera|crea|hazme|haz|convierte(me)?|léeme|leeme|nárrame|narrame|dame|pon)\s+(un\s+|el\s+|la\s+)?(audio|voz|narración|narracion|podcast|mp3)\s*(de|que diga|con el texto|:)?/i, "").trim();
          if (!textoNarrar || textoNarrar.length < 3) textoNarrar = mensaje;
          const r = await generarAudio(textoNarrar, "es");
          resultado = { accion: "audio", ...r };
          textoRespuesta = `✅ Audio generado (voz en español)`;

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
//  /agente — MOTOR DE HERRAMIENTAS (razona y ejecuta)
// ══════════════════════════════════════════════
// Detecta si un texto está en español o inglés (heurística ligera, suficiente para elegir la voz correcta)
function detectarIdioma(texto) {
  const t = (texto || "").toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(t)) return "es";   // señal fuerte e inequívoca de español
  const esWords = (t.match(/\b(el|la|los|las|de|que|y|en|un|una|es|para|con|por|no|sí|más|pero|hola|gracias)\b/g) || []).length;
  const enWords = (t.match(/\b(the|is|and|to|of|in|for|with|you|your|not|but|are|this|that|hello|thanks)\b/g) || []).length;
  return enWords > esWords ? "en" : "es";
}

app.post("/agente", async (req, res) => {
  const { mensaje, agente = "general", conversacion_id, usuario } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Falta mensaje" });
  try {
    // Gestionar la conversación y recuperar el hilo para dar contexto al agente
    let convId = conversacion_id;
    let previos = [];   // mensajes anteriores del hilo (para que el agente siga el contexto)
    try {
      if (convId) {
        // conversación existente: cargamos el hilo ANTES de añadir el mensaje nuevo
        const data = await cargarConversacion(convId);
        previos = (data.mensajes || []).slice(-10).map(m => ({
          role: m.rol === "user" ? "user" : "assistant",
          content: String(m.contenido || "").slice(0, 1500)
        }))
        // Un turno roto (el agente se quedó sin pasos y no completó nada) NO debe
        // recargarse como contexto — si no, el modelo "revive" la confusión en cada
        // mensaje nuevo de ese mismo hilo, en vez de tratarlo como algo fresco.
        .filter(m => m.content && !/tarea procesada \(se alcanzó el límite de pasos\)/i.test(m.content));
      } else {
        const convNueva = await crearConversacion(usuario, mensaje, agente);
        convId = convNueva?.id;
      }
      if (convId) await guardarMensaje(convId, "user", mensaje, null, null);
    } catch(e) { logger.error("No se pudo preparar conversación: " + e.message); }

    // Ejecutar el motor de herramientas CON el hilo de la conversación
    const r = await ejecutarConHerramientas(mensaje, agente, 6, previos);

    // Guardar la respuesta del agente (artefactos livianos: solo metadata, no el base64 pesado)
    try {
      if (convId) {
        const artefactosLiv = (r.artefactos || []).map(a => ({ tipo: a.tipo, nombre: a.nombre || null }));
        await guardarMensaje(convId, "assistant", r.respuesta, artefactosLiv, r.pasos);
      }
    } catch(e) { logger.error("No se pudo guardar respuesta: " + e.message); }

    res.json({
      conversacion_id: convId,     // el frontend lo reutiliza para seguir el hilo
      agente: (AGENTES[agente] || AGENTES.general).nombre,
      respuesta: r.respuesta,
      idioma: detectarIdioma(r.respuesta),  // para que la voz hable en el idioma correcto
      pasos: r.pasos,
      artefactos: r.artefactos,
      total_pasos: r.pasos.length
    });
  } catch(e) {
    logger.error("Error /agente: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════
//  MENÚ LATERAL — conversaciones guardadas
// ══════════════════════════════════════════════
// Listar conversaciones (para pintar el menú lateral)
app.get("/conversaciones", async (req, res) => {
  try { res.json(await listarConversaciones(req.query.usuario)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear conversación vacía (botón "nueva conversación")
app.post("/conversaciones", async (req, res) => {
  try {
    const { usuario, titulo, agente } = req.body;
    res.json(await crearConversacion(usuario, titulo, agente));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Abrir una conversación con todos sus mensajes
app.get("/conversaciones/:id", async (req, res) => {
  try { res.json(await cargarConversacion(req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Renombrar una conversación
app.patch("/conversaciones/:id", async (req, res) => {
  try { await renombrarConversacion(req.params.id, req.body.titulo); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar una conversación
app.delete("/conversaciones/:id", async (req, res) => {
  try { await borrarConversacion(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
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

// ── AUDIO: Texto → Voz (TTS) ──
app.post("/generar/audio", async (req, res) => {
  const { texto, idioma = "es" } = req.body;
  if (!texto) return res.status(400).json({ error: "Falta texto" });
  try {
    const r = await generarAudio(texto, idioma);
    res.json({ status: "ok", ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUDIO: Voz → Texto (Whisper) ──
app.post("/transcribir", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta archivo de audio" });
  try {
    const r = await transcribirAudio(req.file.buffer);
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

// ══════════════════════════════════════════════
//  RESUMIR — textos cortos directo, largos por partes (map-reduce)
// ══════════════════════════════════════════════
const SYS_RESUMIDOR = `Eres un editor experto en síntesis. Resumes con precisión, sin inventar datos, conservando las ideas y el tono importantes del original.`;
const UMBRAL_TROZO = 6000; // caracteres: por debajo, se resume de un tirón; por encima, se trocea

// Divide el texto en trozos por párrafos (para no cortar una idea a la mitad)
function trocearTexto(texto, tam = UMBRAL_TROZO) {
  const parrafos = texto.split(/\n\s*\n/);
  const trozos = []; let actual = "";
  for (const p of parrafos) {
    if ((actual + "\n\n" + p).length > tam && actual) { trozos.push(actual); actual = p; }
    else actual = actual ? actual + "\n\n" + p : p;
  }
  if (actual) trozos.push(actual);
  return trozos;
}

// nivel: "breve" (2-3 frases), "medio" (un párrafo), "detallado" (varios párrafos con puntos clave)
async function resumirTexto(texto, nivel = "medio") {
  const instrucciones = {
    breve: "Resume en 2-3 frases, solo la idea central.",
    medio: "Resume en un párrafo claro con los puntos principales.",
    detallado: "Haz un resumen detallado, con los puntos clave en viñetas si ayuda a la claridad."
  };
  const instr = instrucciones[nivel] || instrucciones.medio;

  if (texto.length <= UMBRAL_TROZO) {
    // Texto corto: una sola llamada, directo
    return (await llamarCF(MODELOS.potente, [
      { role: "system", content: SYS_RESUMIDOR },
      { role: "user", content: `${instr}\n\nTexto:\n${texto}` }
    ], 700)).trim();
  }

  // Texto largo: MAP (resumir cada trozo) → REDUCE (resumir la unión de los resúmenes)
  const trozos = trocearTexto(texto);
  const resumenesParciales = [];
  for (const trozo of trozos) {
    const r = await llamarCF(MODELOS.potente, [
      { role: "system", content: SYS_RESUMIDOR },
      { role: "user", content: `Resume este fragmento conservando los datos y nombres importantes (se combinará con otros resúmenes después):\n\n${trozo}` }
    ], 500);
    resumenesParciales.push(r.trim());
  }
  const union = resumenesParciales.join("\n\n");
  // Si la unión de resúmenes sigue siendo larga, se resume una vez más (reduce final)
  const final = await llamarCF(MODELOS.potente, [
    { role: "system", content: SYS_RESUMIDOR },
    { role: "user", content: `${instr}\n\nEstos son los resúmenes de las distintas partes de un mismo texto; únelos en un resumen coherente del conjunto:\n\n${union}` }
  ], 900);
  return final.trim();
}

// ══════════════════════════════════════════════
//  BIBLIOTECA GRATUITA — Project Gutenberg vía Gutendex
//  70.000+ libros de DOMINIO PÚBLICO, sin clave, sin registro, legal para siempre
// ══════════════════════════════════════════════
app.get("/libro/buscar", async (req, res) => {
  const q = (req.query.q || "").trim();
  const idioma = (req.query.idioma || "").trim(); // "es" para filtrar solo español, vacío = todos
  const modo = (req.query.modo || "texto").trim(); // "texto" = título/autor, "tema" = asunto/categoría (bookshelf)
  if (!q) return res.status(400).json({ error: "Falta el término de búsqueda" });
  try {
    const parametro = modo === "tema" ? "topic" : "search";
    let url = `https://gutendex.com/books?${parametro}=${encodeURIComponent(q)}`;
    if (idioma) url += `&languages=${encodeURIComponent(idioma)}`;
    const data = await (await fetch(url)).json();
    const libros = (data.results || []).slice(0, 20).map(b => ({
      id: b.id,
      titulo: b.title,
      autor: (b.authors && b.authors[0] && b.authors[0].name) || "Autor desconocido",
      idioma: (b.languages && b.languages[0]) || "?",
      descargas: b.download_count,
      // Solo se puede importar si Gutenberg publicó una versión en texto plano
      tieneTexto: !!(b.formats && Object.keys(b.formats).some(k => k.startsWith("text/plain")))
    }));
    registrarHistorial({ tipo: "busqueda", titulo: q, tema: modo === "tema" ? q : "", fuente: "gutenberg" }); // no bloquea la respuesta
    res.json({ ok: true, libros, total: data.count || libros.length });
  } catch(e) { logger.error("/libro/buscar: " + e.message); res.status(500).json({ error: e.message }); }
});

app.get("/libro/importar/:id", async (req, res) => {
  try {
    const meta = await (await fetch(`https://gutendex.com/books/${req.params.id}`)).json();
    const formatos = meta.formats || {};
    const claveTxt = Object.keys(formatos).find(k => k.startsWith("text/plain"));
    if (!claveTxt) return res.status(404).json({ error: "Este libro no tiene una versión de texto plano disponible" });
    let texto = await (await fetch(formatos[claveTxt])).text();
    // Quitar el aviso legal que Gutenberg añade al inicio/final (no es parte de la obra)
    const iniM = texto.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i);
    const finM = texto.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
    if (iniM >= 0) texto = texto.slice(texto.indexOf("\n", iniM) + 1);
    if (finM >= 0) {
      const finRelativo = texto.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i); // recalcular tras el recorte inicial
      if (finRelativo >= 0) texto = texto.slice(0, finRelativo);
    }
    texto = texto.trim();
    const titulo = meta.title, autor = (meta.authors && meta.authors[0] && meta.authors[0].name) || "";
    const tema = (meta.subjects && meta.subjects[0]) || (meta.bookshelves && meta.bookshelves[0]) || "";
    registrarHistorial({ tipo: "lectura", titulo, autor, tema, fuente: "gutenberg", gutenberg_id: meta.id });
    indexarConocimiento({ contenido: texto, origen: "gutenberg", referencia: titulo }); // no bloquea la respuesta
    res.json({ ok: true, titulo, autor, texto, caracteres: texto.length });
  } catch(e) { logger.error("/libro/importar: " + e.message); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  BIBLIOTECA INTERNA — lee libros en cualquier formato desde su ruta,
//  y el sistema los gestiona (listar, buscar, cargar)
// ══════════════════════════════════════════════
const DIR_ENTRADA = path.join(SAFE_ROOT, "libros_entrada");
try { if (!fs.existsSync(DIR_ENTRADA)) fs.mkdirSync(DIR_ENTRADA, { recursive: true }); } catch(e) {}

// Extrae el texto de un archivo sin importar su formato (.txt/.md, .pdf, .docx, .epub)
async function extraerTextoDeArchivo(rutaCompleta) {
  const ext = path.extname(rutaCompleta).toLowerCase();

  if (ext === ".txt" || ext === ".md") {
    return fs.readFileSync(rutaCompleta, "utf8");
  }

  if (ext === ".pdf") {
    let pdfParse;
    try { pdfParse = require("pdf-parse"); }
    catch(e) { throw new Error("Falta instalar la librería de PDF: npm install pdf-parse"); }
    const datos = await pdfParse(fs.readFileSync(rutaCompleta));
    return datos.text;
  }

  if (ext === ".docx") {
    let mammoth;
    try { mammoth = require("mammoth"); }
    catch(e) { throw new Error("Falta instalar la librería de Word: npm install mammoth"); }
    const r = await mammoth.extractRawText({ path: rutaCompleta });
    return r.value;
  }

  if (ext === ".epub") {
    // Un EPUB es en realidad un ZIP con páginas HTML dentro — lo abrimos y quitamos las etiquetas
    let AdmZip;
    try { AdmZip = require("adm-zip"); }
    catch(e) { throw new Error("Falta instalar la librería de EPUB: npm install adm-zip"); }
    const zip = new AdmZip(rutaCompleta);
    const paginas = zip.getEntries().filter(e => /\.x?html?$/i.test(e.entryName));
    let texto = "";
    for (const pagina of paginas) {
      const html = zip.readAsText(pagina);
      texto += html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ") + "\n\n";
    }
    return texto.trim();
  }

  throw new Error(`Formato no soportado: ${ext} (admitidos: .txt, .md, .pdf, .docx, .epub)`);
}

// Lista los libros que hay guardados en la biblioteca interna, con filtro opcional por nombre
app.get("/libro/listar-archivos", (req, res) => {
  try {
    const filtro = (req.query.q || "").toLowerCase();
    let archivos = fs.existsSync(DIR_ENTRADA) ? fs.readdirSync(DIR_ENTRADA) : [];
    if (filtro) archivos = archivos.filter(a => a.toLowerCase().includes(filtro));
    const detalle = archivos.map(nombre => {
      let bytes = 0;
      try { bytes = fs.statSync(path.join(DIR_ENTRADA, nombre)).size; } catch(e) {}
      return { nombre, formato: path.extname(nombre).replace(".", "").toUpperCase(), bytes };
    });
    res.json({ ok: true, archivos: detalle });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Carga el texto de un libro concreto de la biblioteca interna, sin importar su formato
app.get("/libro/leer-archivo", async (req, res) => {
  const nombre = req.query.nombre || "";
  if (!nombre) return res.status(400).json({ error: "Falta el nombre del archivo" });
  // Seguridad: solo se puede leer DENTRO de libros_entrada, nunca salir de esa carpeta
  const ruta = path.join(DIR_ENTRADA, path.basename(nombre));
  if (!fs.existsSync(ruta)) return res.status(404).json({ error: "Ese archivo no está en la biblioteca interna" });
  try {
    const texto = (await extraerTextoDeArchivo(ruta)).trim();
    registrarHistorial({ tipo: "lectura", titulo: nombre, fuente: "interna" });
    indexarConocimiento({ contenido: texto, origen: "biblioteca_interna", referencia: nombre }); // no bloquea la respuesta
    res.json({ ok: true, nombre, texto, caracteres: texto.length });
  } catch(e) { logger.error("/libro/leer-archivo: " + e.message); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  RECOMENDACIONES — sugiere títulos según lo que se ha buscado y leído
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
//  INCUBADORA — catálogo de proyectos de Fundora (BetGroup Pro, Estudio de Libros, PAS, etc.)
//  APK o web, con peso y especificaciones — se gestiona desde el Studio y se muestra en público
// ══════════════════════════════════════════════
app.get("/incubadora/proyectos", async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/proyectos_incubadora?select=*&order=orden.asc,creado_en.desc`, { headers: SUPA() });
    const proyectos = await r.json();
    res.json({ ok: true, proyectos });
  } catch(e) { logger.error("/incubadora/proyectos GET: " + e.message); res.status(500).json({ error: e.message }); }
});

app.post("/incubadora/proyectos", async (req, res) => {
  const { nombre, tipo, enlace, peso_mb = null, descripcion = "", especificaciones = "", estado = "en desarrollo", orden = 0 } = req.body || {};
  if (!nombre || !tipo || !enlace) return res.status(400).json({ error: "Faltan nombre, tipo o enlace" });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/proyectos_incubadora`, {
      method: "POST", headers: { ...SUPA(), "Prefer": "return=representation" },
      body: JSON.stringify({ nombre, tipo, enlace, peso_mb, descripcion, especificaciones, estado, orden })
    });
    const data = await r.json();
    res.json({ ok: true, proyecto: data[0] || data });
  } catch(e) { logger.error("/incubadora/proyectos POST: " + e.message); res.status(500).json({ error: e.message }); }
});

app.patch("/incubadora/proyectos/:id", async (req, res) => {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/proyectos_incubadora?id=eq.${req.params.id}`, {
      method: "PATCH", headers: SUPA(), body: JSON.stringify(req.body || {})
    });
    res.json({ ok: true });
  } catch(e) { logger.error("/incubadora/proyectos PATCH: " + e.message); res.status(500).json({ error: e.message }); }
});

app.delete("/incubadora/proyectos/:id", async (req, res) => {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/proyectos_incubadora?id=eq.${req.params.id}`, { method: "DELETE", headers: SUPA() });
    res.json({ ok: true });
  } catch(e) { logger.error("/incubadora/proyectos DELETE: " + e.message); res.status(500).json({ error: e.message }); }
});

app.get("/libro/recomendados", async (req, res) => {
  const usuario = (req.query.usuario || "anon").trim();
  try {
    // 1) Traer el historial reciente de este usuario (por ahora compartido, no hay cuentas públicas todavía)
    const histResp = await fetch(
      `${SUPABASE_URL}/rest/v1/historial_lectura?usuario=eq.${encodeURIComponent(usuario)}&order=creado_en.desc&limit=40`,
      { headers: SUPA() }
    );
    const historial = await histResp.json();

    if (!Array.isArray(historial) || historial.length === 0) {
      return res.json({ ok: true, recomendaciones: [], motivo: "Aún no hay historial suficiente — busca o lee un par de libros y aquí aparecerán sugerencias" });
    }

    // 2) Contar qué temas y autores se repiten más, para saber qué le interesa de verdad
    const conteoTemas = {}, conteoAutores = {}, yaLeidos = new Set();
    for (const h of historial) {
      if (h.tema) conteoTemas[h.tema] = (conteoTemas[h.tema] || 0) + 1;
      if (h.autor) conteoAutores[h.autor] = (conteoAutores[h.autor] || 0) + 1;
      if (h.titulo) yaLeidos.add(h.titulo.toLowerCase());
    }
    const temasTop = Object.entries(conteoTemas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(t => t[0]);
    const autoresTop = Object.entries(conteoAutores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(a => a[0]);

    // 3) Traer candidatos reales de Gutenberg para esos temas/autores (evitando repetir lo ya leído)
    const candidatos = [];
    for (const tema of temasTop) {
      try {
        const d = await (await fetch(`https://gutendex.com/books?topic=${encodeURIComponent(tema)}`)).json();
        for (const b of (d.results || []).slice(0, 6)) {
          if (!yaLeidos.has((b.title || "").toLowerCase())) {
            candidatos.push({ id: b.id, titulo: b.title, autor: (b.authors && b.authors[0] && b.authors[0].name) || "", tema });
          }
        }
      } catch(e) {}
    }
    for (const autor of autoresTop) {
      try {
        const d = await (await fetch(`https://gutendex.com/books?search=${encodeURIComponent(autor)}`)).json();
        for (const b of (d.results || []).slice(0, 4)) {
          if (!yaLeidos.has((b.title || "").toLowerCase())) {
            candidatos.push({ id: b.id, titulo: b.title, autor: (b.authors && b.authors[0] && b.authors[0].name) || autor, tema: "mismo autor" });
          }
        }
      } catch(e) {}
    }

    if (candidatos.length === 0) {
      return res.json({ ok: true, recomendaciones: [], motivo: "No se encontraron títulos nuevos relacionados con tu historial por ahora" });
    }

    // 4) Pedirle al modelo que elija y justifique las mejores 5, en vez de mostrar la lista cruda
    const listaCand = candidatos.slice(0, 20).map(c => `- "${c.titulo}" de ${c.autor} (tema: ${c.tema}, id:${c.id})`).join("\n");
    const respuesta = await llamarCF(MODELOS.potente, [
      { role: "system", content: "Eres un curador de lecturas. Eliges y justificas recomendaciones con criterio, en frases breves y personales, sin inventar datos fuera de la lista dada." },
      { role: "user", content: `El lector ha buscado/leído sobre: ${temasTop.join(", ") || "temas variados"}${autoresTop.length ? " y autores como " + autoresTop.join(", ") : ""}.
Elige las 5 mejores opciones de esta lista de candidatos y explica en una frase por qué encajarían con sus gustos:
${listaCand}

Responde SOLO con un JSON: {"recomendaciones":[{"titulo":"...","autor":"...","id":0,"motivo":"..."}]}` }
    ], 900);
    const parseado = extraerJSON(respuesta);
    const recomendaciones = (parseado && parseado.recomendaciones) ? parseado.recomendaciones : candidatos.slice(0, 5).map(c => ({ titulo: c.titulo, autor: c.autor, id: c.id, motivo: `Relacionado con ${c.tema}` }));
    res.json({ ok: true, recomendaciones });
  } catch(e) { logger.error("/libro/recomendados: " + e.message); res.status(500).json({ error: e.message }); }
});

app.post("/resumir", async (req, res) => {
  const { texto = "", nivel = "medio" } = req.body || {};
  if (!texto.trim()) return res.status(400).json({ error: "Falta el texto a resumir" });
  try {
    const resumen = await resumirTexto(texto, nivel);
    res.json({ ok: true, resumen, caracteres_original: texto.length, troceado: texto.length > UMBRAL_TROZO });
  } catch(e) { logger.error("/resumir: " + e.message); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  ESTUDIO DE LIBROS — Escritor por capítulos
// ══════════════════════════════════════════════
const SYS_ESCRITOR = `Eres un escritor y editor profesional de Fundora Agency. Escribes libros y novelas con prosa cuidada, coherente y envolvente. Respetas el género, el tono y el idioma que se te pidan.`;

// Extrae un objeto JSON de la respuesta del modelo, tolerando fences ```json y texto alrededor
function extraerJSON(txt) {
  if (!txt) return null;
  if (typeof txt === "object") return txt;   // Cloudflare a veces devuelve el JSON ya parseado
  let s = String(txt).replace(/```json/gi, "").replace(/```/g, "").trim();
  const ini = s.indexOf("{"), fin = s.lastIndexOf("}");
  if (ini >= 0 && fin > ini) s = s.slice(ini, fin + 1);
  try { return JSON.parse(s); } catch(e) { return null; }
}

// 1) ESQUEMA: título, sinopsis, personajes e índice (la "biblia" que da coherencia al libro)
// Genera la CARÁTULA del libro con FLUX: es lo primero que ve un lector, y la portada vende
app.post("/libro/portada", async (req, res) => {
  const { titulo = "", sinopsis = "", genero = "" } = req.body || {};
  if (!titulo) return res.status(400).json({ error: "Falta el título" });
  try {
    // Sin texto en el prompt: FLUX deforma las letras, así que jugamos con atmósfera y simbolismo, no palabras
    const prompt = `Book cover illustration for a ${genero || "novel"} titled inspired by: ${sinopsis || titulo}. Professional book cover design, striking composition, dramatic lighting, no text, no letters, publisher quality, 4k detail`;
    const r = await generarImagen(prompt);
    const url = archivarCreacion({ tipo: "imagen", imagen: r.imagen }); // también queda en el Stock
    res.json({ ok: true, portada: r.imagen, url });
  } catch(e) { logger.error("/libro/portada: " + e.message); res.status(500).json({ error: e.message }); }
});

app.post("/libro/esquema", async (req, res) => {
  const { idea = "", genero = "novela", tono = "", capitulos = 5, idioma = "español", base = "" } = req.body || {};
  if (!idea && !base) return res.status(400).json({ error: "Falta la idea o un texto base" });
  const nCap = Math.max(2, Math.min(parseInt(capitulos) || 5, 20));   // tope sano para no agotar cuota
  try {
    const instruccion = `Diseña el esquema de un libro en ${idioma}.
Género: ${genero}. Tono: ${tono || "libre"}. Capítulos: ${nCap}.
${base ? "Parte de este material del autor:\n" + String(base).slice(0, 4000) + "\n" : ""}Idea: ${idea || "(desarrolla a partir del material del autor)"}

Responde SOLO con un JSON válido, sin texto extra, con esta forma exacta:
{"titulo":"...","sinopsis":"2-3 frases","personajes":[{"nombre":"...","rol":"..."}],"capitulos":[{"n":1,"titulo":"...","resumen":"1 frase"}]}
El array capitulos debe tener exactamente ${nCap} elementos.`;
    const resp = await llamarCF(MODELOS.potente, [
      { role: "system", content: SYS_ESCRITOR + " Devuelves SOLO JSON válido cuando se te pide." },
      { role: "user", content: instruccion }
    ], 1200);
    const esquema = extraerJSON(resp);
    if (!esquema || !Array.isArray(esquema.capitulos)) return res.status(502).json({ error: "El modelo no devolvió un esquema válido", crudo: resp });
    res.json({ ok: true, esquema });
  } catch(e) { logger.error("/libro/esquema: " + e.message); res.status(500).json({ error: e.message }); }
});

// 2) CAPÍTULO: escribe un capítulo concreto usando el esquema completo como contexto (continuidad)
app.post("/libro/capitulo", async (req, res) => {
  const { esquema, n = 1, idioma = "español" } = req.body || {};
  if (!esquema || !Array.isArray(esquema.capitulos)) return res.status(400).json({ error: "Falta el esquema" });
  const cap = esquema.capitulos.find(c => Number(c.n) === Number(n)) || esquema.capitulos[n - 1];
  if (!cap) return res.status(400).json({ error: "Capítulo fuera de rango" });
  try {
    const indice = esquema.capitulos.map(c => `${c.n}. ${c.titulo}`).join("\n");
    const personajes = (esquema.personajes || []).map(p => `- ${p.nombre}: ${p.rol}`).join("\n");
    const instruccion = `Escribe el capítulo ${cap.n} del libro "${esquema.titulo}", en ${idioma}.
Sinopsis general: ${esquema.sinopsis}
Personajes:
${personajes}
Índice completo (para mantener la continuidad):
${indice}

Capítulo a escribir — "${cap.titulo}": ${cap.resumen}

Escribe SOLO la prosa del capítulo (sin poner "Capítulo X" ni notas), entre 600 y 900 palabras, coherente con lo anterior y lo que vendrá.`;
    const texto = await llamarCF(MODELOS.potente, [
      { role: "system", content: SYS_ESCRITOR },
      { role: "user", content: instruccion }
    ], 1600);
    res.json({ ok: true, n: cap.n, titulo: cap.titulo, texto: (texto || "").trim() });
  } catch(e) { logger.error("/libro/capitulo: " + e.message); res.status(500).json({ error: e.message }); }
});

// 3) PDF: arma el libro terminado en PDF y lo deja guardado en el Stock
app.post("/libro/pdf", async (req, res) => {
  const { titulo = "Libro", contenido = "", portada = null } = req.body || {};
  if (!contenido) return res.status(400).json({ error: "Falta el contenido del libro" });
  try {
    const r = await generarPDF(titulo, contenido, portada);
    const url = archivarCreacion({ tipo: "pdf", pdf: r.pdf });   // queda en la Biblioteca/Stock
    res.json({ ok: true, url, nombre: r.nombre });
  } catch(e) { logger.error("/libro/pdf: " + e.message); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════
//  NARRAR — audiolibro: trocea el texto, genera voz por partes y las une
// ══════════════════════════════════════════════
// Corta el texto en trozos que respetan el límite de MeloTTS (450 caracteres),
// SIN partir una frase a la mitad — busca el punto más cercano antes del límite.
function trocearParaVoz(texto, tam = 450) {
  const limpio = texto.replace(/\s+/g, " ").trim();
  const trozos = []; let resto = limpio;
  while (resto.length > tam) {
    let corte = resto.lastIndexOf(". ", tam);
    if (corte < tam * 0.4) corte = tam;              // si no hay un punto cerca, se corta igual (mejor que trozos gigantes)
    trozos.push(resto.slice(0, corte + 1).trim());
    resto = resto.slice(corte + 1).trim();
  }
  if (resto) trozos.push(resto);
  return trozos;
}

// Narra un texto completo: genera un MP3 por trozo y los concatena en uno solo con ffmpeg
async function narrarTexto(texto, lang = "ES") {
  const trozos = trocearParaVoz(texto);
  const rutas = [];
  for (let i = 0; i < trozos.length; i++) {
    // Cloudflare a veces da un error interno pasajero — reintentamos una vez antes de rendirnos,
    // para que un tropiezo aislado no deje un hueco de silencio en medio del audiolibro
    let r = null;
    for (let intento = 0; intento < 2 && !r; intento++) {
      try { r = await generarAudio(trozos[i], lang); }
      catch(e) {
        logger.warn(`Trozo de narración ${i} (intento ${intento + 1}) falló: ${e.message}`);
        if (intento === 0) await new Promise(res => setTimeout(res, 1500)); // pausa breve antes de reintentar
      }
    }
    try {
      if (r && r.audio) {
        const m = r.audio.match(/^data:audio\/[^;]+;base64,(.*)$/s);
        if (m) {
          const rp = path.join(TMP_DIR, `narr_${i}.mp3`);
          fs.writeFileSync(rp, Buffer.from(m[1], "base64"));
          rutas.push(rp);
        }
      }
    } catch(e) { logger.warn(`Trozo de narración ${i} no se pudo guardar: ${e.message}`); }
  }
  if (!rutas.length) throw new Error("No se pudo narrar ningún fragmento");

  const salida = path.join(TMP_DIR, `narracion_${Date.now()}.mp3`);
  if (rutas.length === 1) {
    fs.copyFileSync(rutas[0], salida);
  } else {
    // Concatenar todos los mp3 en uno solo, en el orden correcto
    const lista = path.join(TMP_DIR, "narr_lista.txt");
    fs.writeFileSync(lista, rutas.map(r => `file '${r}'`).join("\n"));
    execSync(`ffmpeg -y -f concat -safe 0 -i "${lista}" -c copy "${salida}" 2>/dev/null`);
    try { fs.unlinkSync(lista); } catch(e) {}
  }
  for (const r of rutas) { try { fs.unlinkSync(r); } catch(e) {} }
  const b64 = fs.readFileSync(salida).toString("base64");
  try { fs.unlinkSync(salida); } catch(e) {}
  return { audio: "data:audio/mpeg;base64," + b64, partes: trozos.length };
}

app.post("/narrar", async (req, res) => {
  const { texto = "", lang = "ES" } = req.body || {};
  if (!texto.trim()) return res.status(400).json({ error: "Falta el texto a narrar" });
  try {
    const r = await narrarTexto(texto, lang);
    const url = archivarCreacion({ tipo: "audio", audio: r.audio });   // queda en el Stock
    res.json({ ok: true, url, partes: r.partes });
  } catch(e) { logger.error("/narrar: " + e.message); res.status(500).json({ error: e.message }); }
});

app.get("/biblioteca", (req, res) => {
  try {
    // Clasifica cada archivo por su extensión → tipo mostrable en la galería
    const porExt = { jpg:"imagen", jpeg:"imagen", png:"imagen", webp:"imagen", gif:"imagen", mp4:"video", webm:"video", mp3:"audio", wav:"audio", ogg:"audio", pdf:"pdf" };
    const nombres = fs.existsSync(DIR_GENERADOS) ? fs.readdirSync(DIR_GENERADOS) : [];
    const creaciones = nombres
      .map(n => {
        const ext = (n.split(".").pop() || "").toLowerCase();
        const tipo = porExt[ext] || "archivo";   // código/texto se muestran como "archivo" descargable
        let fecha = 0, bytes = 0;
        try { const st = fs.statSync(path.join(DIR_GENERADOS, n)); fecha = st.mtimeMs; bytes = st.size; } catch(e) {}
        return { nombre: n, tipo, url: "/generados/" + n, fecha, bytes };
      })
      .sort((a, b) => b.fecha - a.fecha);          // lo más reciente primero
    res.json({ creaciones, total: creaciones.length });
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
      codigo: MODELOS.codigo,
      imagen: MODELOS.imagen,
      audio_tts: MODELOS.audio_tts,
      audio_stt: MODELOS.audio_stt
    }
  });
});

app.get("/skills", (req, res) => {
  res.json({
    sistema: "FUNDORA AGENCY AI v4.2",
    agentes: Object.keys(AGENTES).length,
    orquestador: "Detección automática de intenciones — imagen, video, audio, PDF, código",
    motores_gratuitos: {
      texto: "Cloudflare Llama 3.3 70B + Groq",
      imagen: "FLUX.1 Schnell (~100k/día) con fallback SDXL",
      audio_tts: "MeloTTS (texto → voz)",
      audio_stt: "Whisper v3 Turbo (voz → texto)",
      video: "FLUX frames + ffmpeg",
      pdf: "pdfkit local"
    },
    endpoints: [
      "GET /health", "GET /agentes", "GET /stats", "GET /skills",
      "POST /chat (orquestador regex — detecta imagen/video/audio/pdf/codigo)",
      "POST /agente (MOTOR DE HERRAMIENTAS — razona, encadena, ejecuta tareas reales)",
      "POST /consulta", "POST /verificar", "POST /validar", "POST /feedback",
      "GET /memoria/:agenteId", "POST /memoria/buscar",
      "POST /agentes/crear", "POST /agentes/:id/clonar", "POST /agentes/:id/conocimiento",
      "POST /generar/imagen", "POST /generar/imagen-ilimitado",
      "POST /generar/img2img", "POST /generar/video", "POST /generar/video-cloudflare",
      "POST /generar/audio (TTS)", "POST /transcribir (Whisper)",
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

// Servir el STUDIO (interfaz de chat con menú lateral de conversaciones)
app.get("/studio", (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");  // que el navegador NO sirva versión vieja
    res.type("html").send(fs.readFileSync(path.join(SAFE_ROOT, "studio.html"), "utf8"));
  } catch(e) {
    res.status(500).send("studio.html no encontrado en " + SAFE_ROOT);
  }
});

// ── INCUBADORA · vitrina pública de proyectos (BetGroup Pro, PAS, Estudio de Libros, etc.) ──
app.get("/incubadora", (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.type("html").send(fs.readFileSync(path.join(SAFE_ROOT, "incubadora.html"), "utf8"));
  } catch(e) {
    res.status(500).send("incubadora.html no encontrado en " + SAFE_ROOT);
  }
});

// ── MONITOR · "el latido": pulso del sistema de un vistazo ──
app.get("/monitor/estado", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    servidor: "vivo",
    uptime_seg: Math.floor(process.uptime()),
    memoria_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    agentes: Object.keys(AGENTES).length,
    supabase: SUPABASE_KEY ? "conectado" : "sin clave",
    cloudflare: (CF_ACCOUNT_ID && CF_TOKEN) ? "configurado" : "sin clave",
    node: process.version,
    hora: new Date().toISOString()
  });
});

// ── MONITOR · "la consola en vivo": transmite los registros por SSE ──
app.get("/monitor/logs", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"     // evita que un proxy retenga el flujo
  });
  if (res.flushHeaders) res.flushHeaders();
  // primero mandamos lo que ya pasó (la cola reciente)
  res.write("data: " + JSON.stringify({ tipo: "historial", lineas: bufferLogs }) + "\n\n");
  clientesSSE.add(res);
  // latido cada 25s para que la conexión no se caiga sola
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch(e) {} }, 25000);
  req.on("close", () => { clearInterval(ping); clientesSSE.delete(res); });
});
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

// ══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ FUNDORA AGENCY AI v4.2 en puerto ${PORT}`);
  console.log(`🤖 ${Object.keys(AGENTES).length} agentes activos`);
  console.log(`⚡ Orquestador de intenciones: ACTIVO`);
  console.log(`🎨 FLUX.1 | 🎬 Video | 🔊 Audio | 📄 PDF | ⌨️ Código — sin botones, solo pedirlo`);
});
