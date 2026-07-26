const express = require("express");
const fetch = require("node-fetch");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ========== CONFIGURACION ==========
const MODELOS = {
  rapido: "Qwen/Qwen2.5-7B-Instruct",
  potente: "moonshotai/Kimi-K2-Instruct-0905",
  codigo: "Qwen/Qwen2.5-Coder-32B-Instruct"
};

const HF_TOKEN = process.env.HF_TOKEN || "";

// ========== PERSONALIDADES ==========
const AGENTES = {
  programador: {
    nombre: "FUNDORA DEV",
    system: "Eres un desarrollador experto en Node.js, Python, React, Firebase, Render y arquitectura de software. Respondes en espanol con codigo limpio, comentado y listo para produccion. Priorizas soluciones simples y escalables."
  },
  psicologo: {
    nombre: "FUNDORA MIND",
    system: "Eres un psicologo clinico experto con enfoque cognitivo-conductual. Hablas en espanol cubano, con calidez y empatia. Ayudas a gestionar emociones, tomar decisiones y mantener equilibrio mental. Nunca diagnosticas, siempre orientas."
  },
  abogado: {
    nombre: "FUNDORA LEX",
    system: "Eres un abogado experto en derecho corporativo, contratos internacionales, derecho mercantil y legislacion de Islas Turks y Caicos. Respondes en espanol, con precision juridica pero lenguaje claro. Siempre adviertes que tus respuestas son orientativas."
  },
  director: {
    nombre: "FUNDORA VISION",
    system: "Eres un director creativo y audiovisual experto en produccion cinematografica, guiones, storytelling, edicion de video, composicion visual y direccion de arte. Respondes en espanol con vision creativa y tecnica."
  },
  analista: {
    nombre: "FUNDORA SPORTS",
    system: "Eres un analista deportivo experto en apuestas, estadisticas, cuotas y predicciones. Conoces MLB, NBA, MMA, FIFA, tenis y todas las ligas del mundo. Usas datos reales para generar analisis y cuotas realistas en espanol cubano con emojis."
  },
  ceo: {
    nombre: "FUNDORA PRIME",
    system: "Eres el asistente estrategico personal de Yoel, CEO de Fundora Prime Atlantic LLC. Conoces todos sus proyectos: BetGroup Pro (plataforma de apuestas), Prime Atlantic Solutions (marketplace Miami-TCI), Nexo (marketplace cubano). Ayudas con estrategia, decisiones de negocio, automatizacion y escalado. Respondes en espanol con vision de alto nivel."
  },
  general: {
    nombre: "FUNDORA AI",
    system: "Eres FUNDORA AI, un asistente omnipotente creado para Yoel Fundora, CEO de Fundora Prime Atlantic LLC en Providenciales, Turks and Caicos. Eres experto en programacion, psicologia, derecho, negocios, deportes, diseno y produccion audiovisual. Respondes siempre en espanol con precision, claridad y caracter cubano."
  }
};

// ========== MEMORIA POR SESION ==========
const memorias = {};

function getMemoria(sessionId, agente) {
  if (!memorias[sessionId]) {
    memorias[sessionId] = {
      agente: agente,
      historial: [{ role: "system", content: AGENTES[agente] ? AGENTES[agente].system : AGENTES.general.system }],
      creado: Date.now()
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
      max_tokens: 1000,
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
    agentes: Object.keys(AGENTES),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Chat con agente
app.post("/chat", async function(req, res) {
  try {
    const { mensaje, agente = "general", sessionId = "default", modelo } = req.body;
    if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });

    const memoria = getMemoria(sessionId, agente);
    memoria.historial.push({ role: "user", content: mensaje });

    const modeloUsar = modelo || (agente === "programador" ? MODELOS.codigo : MODELOS.rapido);
    const respuesta = await consultarHF(memoria.historial, modeloUsar);

    memoria.historial.push({ role: "assistant", content: respuesta });

    res.json({
      agente: AGENTES[agente] ? AGENTES[agente].nombre : "FUNDORA AI",
      respuesta: respuesta,
      sessionId: sessionId,
      historial: memoria.historial.length - 1
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Consulta rapida sin memoria
app.post("/consulta", async function(req, res) {
  try {
    const { mensaje, agente = "general", modelo } = req.body;
    if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });

    const system = AGENTES[agente] ? AGENTES[agente].system : AGENTES.general.system;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: mensaje }
    ];

    const modeloUsar = modelo || MODELOS.rapido;
    const respuesta = await consultarHF(messages, modeloUsar);

    res.json({
      agente: AGENTES[agente] ? AGENTES[agente].nombre : "FUNDORA AI",
      respuesta: respuesta
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Listar agentes
app.get("/agentes", function(req, res) {
  const lista = Object.keys(AGENTES).map(function(key) {
    return { id: key, nombre: AGENTES[key].nombre };
  });
  res.json({ agentes: lista, total: lista.length });
});

// Agregar agente personalizado
app.post("/agentes/crear", function(req, res) {
  const { id, nombre, system } = req.body;
  if (!id || !nombre || !system) return res.status(400).json({ error: "id, nombre y system requeridos" });
  AGENTES[id] = { nombre, system };
  res.json({ success: true, mensaje: "Agente " + nombre + " creado correctamente", id });
});

// Reset memoria de sesion
app.delete("/sesion/:sessionId", function(req, res) {
  delete memorias[req.params.sessionId];
  res.json({ success: true, mensaje: "Memoria borrada" });
});

app.listen(PORT, function() {
  console.log("FUNDORA AI Online - Puerto " + PORT);
  console.log("Agentes disponibles: " + Object.keys(AGENTES).join(", "));
});
