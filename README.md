# FUNDORA AI

Orquestador de agentes inteligentes para los proyectos de Fundora Prime Atlantic LLC.

## Agentes disponibles

| ID | Nombre | Especialidad |
|---|---|---|
| general | FUNDORA AI | Asistente omnipotente |
| programador | FUNDORA DEV | Desarrollo de software |
| psicologo | FUNDORA MIND | Psicologia y bienestar |
| abogado | FUNDORA LEX | Derecho y contratos |
| director | FUNDORA VISION | Produccion audiovisual |
| analista | FUNDORA SPORTS | Analisis deportivo |
| ceo | FUNDORA PRIME | Estrategia de negocio |

## Endpoints

- `GET /health` - Estado del sistema
- `GET /agentes` - Listar agentes
- `POST /chat` - Chat con memoria de sesion
- `POST /consulta` - Consulta rapida sin memoria
- `POST /agentes/crear` - Crear agente personalizado
- `DELETE /sesion/:id` - Borrar memoria de sesion

## Uso

```bash
# Chat con agente programador
curl -X POST https://tu-url/chat \
  -H "Content-Type: application/json" \
  -d {"mensaje":"Como optimizo una query en Firebase?","agente":"programador","sessionId":"yoel-1"}

# Consulta rapida al CEO assistant
curl -X POST https://tu-url/consulta \
  -H "Content-Type: application/json" \
  -d {"mensaje":"Cual es la mejor estrategia para escalar BetGroup?","agente":"ceo"}
```
