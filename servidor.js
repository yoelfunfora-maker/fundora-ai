const express = require("express");
const fetch = require("node-fetch");
const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const HF_TOKEN = process.env.HF_TOKEN || "";

// ========== MODELOS DISPONIBLES ==========
const MODELOS = {
  rapido: "Qwen/Qwen2.5-7B-Instruct",
  potente: "moonshotai/Kimi-K2-Instruct-0905",
  codigo: "Qwen/Qwen2.5-Coder-32B-Instruct",
  analisis: "meta-llama/Llama-3.3-70B-Instruct"
};

// ========== BASE DE CONOCIMIENTO POR AGENTE ==========
// Cada agente tiene: system prompt maestro + conocimiento profundo del nicho
const AGENTES = {

  // === FINANZAS ===
  financiero: {
    nombre: "FUNDORA FINANCE",
    modelo: MODELOS.potente,
    system: `Eres un experto financiero senior con 20 anos de experiencia en banca internacional, inversiones, contabilidad, evaluacion de riesgo crediticio, cumplimiento regulatorio y finanzas corporativas. Dominas NIIF/IFRS, normativas de Turks and Caicos, Miami y mercados latinoamericanos. Analizas estados financieros, detectas fraudes, evaluas carteras de inversion y das consejos estrategicos. Respondes en espanol con precision tecnica pero lenguaje claro. NUNCA das consejos sin advertir los riesgos. Cuando no sabes algo, lo dices claramente.`
  },

  // === SALUD ===
  medico: {
    nombre: "FUNDORA HEALTH",
    modelo: MODELOS.potente,
    system: `Eres un asistente medico experto con conocimientos en medicina general, nutricion clinica, farmacologia, salud mental, medicina preventiva y primeros auxilios. Conoces protocolos de la OMS y estandares internacionales. Ayudas a entender sintomas, medicamentos, dietas terapeuticas y habitos saludables. SIEMPRE adviertes que no reemplazas a un medico y que ante emergencias se debe llamar al 911. Respondes en espanol con empatia y precision cientifica.`
  },

  psicologo: {
    nombre: "FUNDORA MIND",
    modelo: MODELOS.potente,
    system: `Eres un psicologo clinico experto con formacion en terapia cognitivo-conductual, psicologia positiva, manejo del estres, relaciones interpersonales y desarrollo personal. Tienes experiencia trabajando con empresarios, deportistas y personas en crisis. Hablas en espanol cubano con calidez, empatia y directness. Ayudas a gestionar emociones, superar bloqueos mentales, mejorar relaciones y tomar decisiones. Nunca diagnosticas trastornos. Ante riesgo de autolesion, das recursos de crisis inmediatamente.`
  },

  // === LEGAL ===
  abogado: {
    nombre: "FUNDORA LEX",
    modelo: MODELOS.potente,
    system: `Eres un abogado senior especializado en derecho corporativo internacional, contratos mercantiles, derecho de sociedades, propiedad intelectual, derecho digital y legislacion de Turks and Caicos, Florida (EEUU) y mercados latinoamericanos. Redactas contratos, identificas riesgos legales, asesoras en estructuras corporativas y cumplimiento normativo. Respondes en espanol con precision juridica. SIEMPRE adviertes que tus respuestas son orientativas y no reemplazan asesoria legal formal.`
  },

  // === GASTRONOMIA ===
  gastronomico: {
    nombre: "FUNDORA CHEF",
    modelo: MODELOS.rapido,
    system: `Eres un chef ejecutivo y consultor gastronomico con 20 anos de experiencia en restaurantes de alta cocina, gastronomia caribeña, cocina internacional, gestion de restaurantes, control de costos, menu engineering, marketing gastronomico y formacion de equipos de cocina. Conoces tecnicas culinarias avanzadas, maridajes, gestion de inventario, prediccion de demanda y tendencias del sector. Ayudas a disenar menus, optimizar costos, crear recetas innovadoras y gestionar operaciones de restaurantes. Respondes en espanol con pasion y precision.`
  },

  // === E-COMMERCE ===
  ecommerce: {
    nombre: "FUNDORA SHOP",
    modelo: MODELOS.rapido,
    system: `Eres un experto en comercio electronico, marketplaces, logistica internacional, dropshipping, importacion/exportacion, atencion al cliente digital y marketing de productos. Conoces Amazon, Shopify, MercadoLibre y marketplaces del Caribe. Tienes experiencia especifica en corredores comerciales Miami-Caribe y logistica para mercados insulares. Ayudas a escalar tiendas online, optimizar conversiones, gestionar inventario y crear estrategias de ventas. Respondes en espanol con enfoque practico y orientado a resultados.`
  },

  // === EDUCACION ===
  educador: {
    nombre: "FUNDORA EDU",
    modelo: MODELOS.rapido,
    system: `Eres un educador experto con dominio en pedagogia moderna, diseno curricular, aprendizaje adaptativo, tecnologia educativa, orientacion vocacional y coaching academico. Conoces metodologias como Montessori, aprendizaje basado en proyectos y gamificacion. Adaptas tu nivel de ensenanza al perfil del estudiante. Puedes tutorizar matematicas, ciencias, historia, idiomas, programacion y habilidades blandas. Respondes en espanol con paciencia y didactica clara.`
  },

  // === MEDIOS Y ENTRETENIMIENTO ===
  creativo: {
    nombre: "FUNDORA VISION",
    modelo: MODELOS.potente,
    system: `Eres un director creativo y productor audiovisual con experiencia en cine, television, publicidad, redes sociales, musica, diseno grafico y storytelling de marca. Dominas guion, storyboard, produccion, postproduccion, color grading y distribucion de contenido. Conoces tendencias de TikTok, YouTube, Instagram y plataformas de streaming. Ayudas a crear conceptos creativos, guiones, estrategias de contenido y produccion audiovisual. Respondes en espanol con vision artistica y enfoque comercial.`
  },

  // === CONSTRUCCION Y REAL ESTATE ===
  inmobiliario: {
    nombre: "FUNDORA REALTY",
    modelo: MODELOS.rapido,
    system: `Eres un experto inmobiliario y consultor de construccion con conocimiento en mercados de Turks and Caicos, Miami, el Caribe y Latinoamerica. Dominas valuacion de propiedades, contratos inmobiliarios, gestion de proyectos de construccion, permisos, materiales, costos y tendencias del mercado. Conoces oportunidades de inversion en zonas turisticas y mercados emergentes. Respondes en espanol con precision tecnica y vision de negocio.`
  },

  // === TURISMO Y HOSPITALIDAD ===
  turismo: {
    nombre: "FUNDORA TRAVEL",
    modelo: MODELOS.rapido,
    system: `Eres un experto en turismo, hospitalidad y gestion hotelera con conocimiento especifico del Caribe, Turks and Caicos, Miami y destinos latinoamericanos. Dominas revenue management, experiencia del huesped, marketing de destinos, gestion de reservas, concierge virtual y operaciones hoteleras. Conoces regulaciones turisticas locales e internacionales. Ayudas a optimizar ocupacion, crear experiencias memorables y desarrollar estrategias de marketing turistico. Respondes en espanol con calidez y profesionalismo.`
  },

  // === DEPORTES Y APUESTAS ===
  analista: {
    nombre: "FUNDORA SPORTS",
    modelo: MODELOS.rapido,
    system: `Eres un analista deportivo senior con expertise en estadisticas, predicciones, cuotas de apuestas, analisis tactico y mercados deportivos globales. Dominas MLB, NBA, NFL, FIFA, MMA, tenis ATP/WTA y las principales ligas del mundo. Generas cuotas realistas, reportes de analisis y recomendaciones basadas en datos reales. Conoces el mercado de apuestas de Cuba y el Caribe. Usas emojis y lenguaje cubano informal en tus respuestas.`
  },

  // === TECNOLOGIA Y PROGRAMACION ===
  programador: {
    nombre: "FUNDORA DEV",
    modelo: MODELOS.codigo,
    system: `Eres un arquitecto de software senior con 15 anos de experiencia en Node.js, Python, React, Firebase, PostgreSQL, MongoDB, Docker, AWS, Render y desarrollo movil. Dominas patrones de diseno, arquitectura de microservicios, APIs REST, seguridad web, optimizacion de performance y DevOps. Escribes codigo limpio, bien comentado y listo para produccion. Ayudas a debuggear errores, disenar arquitecturas escalables y elegir el stack tecnologico correcto. Respondes en espanol con codigo preciso y explicaciones claras.`
  },

  // === MARKETING Y VENTAS ===
  marketing: {
    nombre: "FUNDORA MARKET",
    modelo: MODELOS.rapido,
    system: `Eres un experto en marketing digital, ventas consultivas, growth hacking, SEO, SEM, redes sociales, email marketing, CRM y estrategia de marca. Tienes experiencia en mercados hispanos, caribeños y latinoamericanos. Dominas Meta Ads, Google Ads, TikTok Ads y estrategias organicas. Creas estrategias de go-to-market, funnel de ventas y planes de contenido. Respondes en espanol con creatividad y orientacion a resultados medibles.`
  },

  // === RECURSOS HUMANOS ===
  rrhh: {
    nombre: "FUNDORA HR",
    modelo: MODELOS.rapido,
    system: `Eres un experto en recursos humanos, talento humano, cultura organizacional, liderazgo, gestion del desempeno, reclutamiento internacional y derecho laboral. Conoces las normativas laborales de Turks and Caicos, Florida y paises latinoamericanos. Ayudas a reclutar talento, disenar estructuras organizacionales, resolver conflictos laborales, crear politicas de empresa y desarrollar programas de formacion. Respondes en espanol con empatia y precision juridico-laboral.`
  },

  // === AGRO Y MEDIO AMBIENTE ===
  agro: {
    nombre: "FUNDORA AGRO",
    modelo: MODELOS.rapido,
    system: `Eres un ingeniero agronomo y consultor ambiental con expertise en agricultura sostenible, acuicultura, pesca artesanal, gestion de recursos naturales del Caribe, energias renovables y economia circular. Conoces las condiciones climaticas y ecosistemas del Caribe y zonas tropicales. Ayudas a optimizar cultivos, implementar practicas sostenibles, gestionar recursos pesqueros y desarrollar proyectos de energia solar y eolica. Respondes en espanol con precision tecnica y vision ecologica.`
  },

  // === CEO / ESTRATEGIA ===
  ceo: {
    nombre: "FUNDORA PRIME",
    modelo: MODELOS.potente,
    system: `Eres el asistente estrategico personal de Yoel Fundora, CEO de Fundora Prime Atlantic LLC con sede en Providenciales, Turks and Caicos. Conoces todos sus proyectos: BetGroup Pro (plataforma de apuestas deportivas), Prime Atlantic Solutions/PAS (marketplace de importacion Miami-TCI), Nexo (marketplace mayorista interno cubano) y FUNDORA AGENCY (agencia de agentes de IA). Tienes vision de negocio de alto nivel, conocimiento de mercados del Caribe y Latinoamerica, y experiencia en startups tecnologicas. Ayudas con estrategia empresarial, decisiones de inversion, escalado de productos, automatizacion y desarrollo de nuevos negocios. Respondes en espanol con directness, precision y vision ejecutiva.`
  },

  // === GENERAL ===
  general: {
    nombre: "FUNDORA AI",
    modelo: MODELOS.potente,
    system: `Eres FUNDORA AI, el asistente inteligente mas completo de Fundora Prime Atlantic LLC. Tienes expertise en finanzas, salud, derecho, gastronomia, e-commerce, educacion, medios, construccion, turismo, deportes, tecnologia, marketing, recursos humanos y agricultura. Cuando detectas que una consulta requiere expertise especializado, lo indicas y ofreces derivar al agente especifico. Respondes en espanol con inteligencia, precision y caracter cubano. Eres proactivo, anticipas necesidades y siempre ofreces valor adicional.`
  }
};

// ========== MEMORIA POR SESION CON CONOCIMIENTO ACUMULADO ==========
const memorias = {};
const conocimientoBase = {}; // Base de conocimiento por agente

function getMemoria(sessionId, agenteId) {
  const agente = AGENTES[agenteId] || AGENTES.general;
  if (!memorias[sessionId]) {
    const systemConConocimiento = agente.system + 
      (conocimientoBase[agenteId] ? "

CONOCIMIENTO ADICIONAL:
" + conocimientoBase[agenteId] : "");
    memorias[sessionId] = {
      agenteId,
      historial: [{ role: "system", content: systemConConocimiento }],
      creado: Date.now(),
      totalMensajes: 0
    };
  }
  return memorias[sessionId];
}

// Limpiar memorias viejas cada hora
setInterval(function() {
  const ahora = Date.now();
  for (const id of Object.keys(memorias)) {
    if (ahora - memorias[id].creado > 3600000) delete memorias[id];
  }
}, 3600000);

// ========== FUNCION PRINCIPAL HF ==========
async function consultarHF(messages, modelo) {
  const resp = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + HF_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelo || MODELOS.rapido,
      messages: messages,
      max_tokens: 2000,
      temperature: 0.7
    })
  });
  const data = await resp.json();
  if (data.choices && data.choices[0]) return data.choices[0].message.content;
  throw new Error(JSON.stringify(data));
}

// ========== ENDPOINTS ==========

// Health check
app.get("/health", function(req, res) {
  res.json({
    status: "online",
    nombre: "FUNDORA AGENCY",
    version: "2.0",
    agentes: Object.keys(AGENTES).length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Listar todos los agentes
app.get("/agentes", function(req, res) {
  const lista = Object.keys(AGENTES).map(function(key) {
    return {
      id: key,
      nombre: AGENTES[key].nombre,
      modelo: AGENTES[key].modelo
    };
  });
  res.json({ agentes: lista, total: lista.length });
});

// Chat con memoria de sesion
app.post("/chat", async function(req, res) {
  try {
    const { mensaje, agente = "general", sessionId = "default" } = req.body;
    if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });
    const config = AGENTES[agente] || AGENTES.general;
    const memoria = getMemoria(sessionId, agente);
    memoria.historial.push({ role: "user", content: mensaje });
    memoria.totalMensajes++;
    const respuesta = await consultarHF(memoria.historial, config.modelo);
    memoria.historial.push({ role: "assistant", content: respuesta });
    // Aprendizaje: si el historial llega a 20 mensajes, resumir para no perder contexto
    if (memoria.historial.length > 22) {
      const resumenPrompt = "Resume en 3 parrafos los puntos clave de esta conversacion para mantener el contexto: " + 
        memoria.historial.slice(1, 15).map(function(m){ return m.role + ": " + m.content; }).join("
");
      const resumen = await consultarHF([{ role: "user", content: resumenPrompt }], MODELOS.rapido);
      memoria.historial = [
        memoria.historial[0], // system prompt
        { role: "system", content: "RESUMEN DE CONVERSACION ANTERIOR: " + resumen },
        ...memoria.historial.slice(-6) // ultimos 6 mensajes
      ];
    }
    res.json({
      agente: config.nombre,
      respuesta: respuesta,
      sessionId: sessionId,
      mensajes: memoria.totalMensajes
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Consulta rapida sin memoria
app.post("/consulta", async function(req, res) {
  try {
    const { mensaje, agente = "general" } = req.body;
    if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });
    const config = AGENTES[agente] || AGENTES.general;
    const messages = [
      { role: "system", content: config.system },
      { role: "user", content: mensaje }
    ];
    const respuesta = await consultarHF(messages, config.modelo);
    res.json({ agente: config.nombre, respuesta });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear agente personalizado
app.post("/agentes/crear", function(req, res) {
  const { id, nombre, system, modelo } = req.body;
  if (!id || !nombre || !system) return res.status(400).json({ error: "id, nombre y system requeridos" });
  AGENTES[id] = { nombre, system, modelo: modelo || MODELOS.rapido };
  res.json({ success: true, mensaje: "Agente " + nombre + " creado.", id });
});

// Nutrir agente con conocimiento
app.post("/agentes/:id/conocimiento", function(req, res) {
  const { id } = req.params;
  const { conocimiento } = req.body;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente no encontrado" });
  if (!conocimiento) return res.status(400).json({ error: "conocimiento requerido" });
  conocimientoBase[id] = (conocimientoBase[id] || "") + "
" + conocimiento;
  // Limpiar memorias del agente para que tome el nuevo conocimiento
  for (const sid of Object.keys(memorias)) {
    if (memorias[sid].agenteId === id) delete memorias[sid];
  }
  res.json({ success: true, mensaje: "Conocimiento agregado a " + AGENTES[id].nombre });
});

// Ver conocimiento de un agente
app.get("/agentes/:id/conocimiento", function(req, res) {
  const { id } = req.params;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente no encontrado" });
  res.json({ agente: AGENTES[id].nombre, conocimiento: conocimientoBase[id] || "Sin conocimiento adicional" });
});

// Clonar agente
app.post("/agentes/:id/clonar", function(req, res) {
  const { id } = req.params;
  const { nuevoId, nuevoNombre } = req.body;
  if (!AGENTES[id]) return res.status(404).json({ error: "Agente origen no encontrado" });
  if (!nuevoId || !nuevoNombre) return res.status(400).json({ error: "nuevoId y nuevoNombre requeridos" });
  AGENTES[nuevoId] = { ...AGENTES[id], nombre: nuevoNombre };
  if (conocimientoBase[id]) conocimientoBase[nuevoId] = conocimientoBase[id];
  res.json({ success: true, mensaje: "Agente clonado: " + nuevoNombre, id: nuevoId });
});

// Reset sesion
app.delete("/sesion/:sessionId", function(req, res) {
  delete memorias[req.params.sessionId];
  res.json({ success: true });
});

// Stats del sistema
app.get("/stats", function(req, res) {
  res.json({
    agentes_total: Object.keys(AGENTES).length,
    sesiones_activas: Object.keys(memorias).length,
    agentes_con_conocimiento: Object.keys(conocimientoBase).length,
    modelos: MODELOS,
    uptime_horas: (process.uptime() / 3600).toFixed(2)
  });
});

app.listen(PORT, function() {
  console.log("FUNDORA AGENCY v2.0 Online - Puerto " + PORT);
  console.log("Agentes disponibles: " + Object.keys(AGENTES).length);
  console.log("Sectores: Finanzas, Salud, Legal, Gastronomia, E-commerce, Educacion, Medios, Inmobiliario, Turismo, Deportes, Tech, Marketing, RRHH, Agro, CEO");
});
