# EXTERNAL AI INTEGRATION (Fase 20)

Interface ExternalAIProvider desacoplada de provedor específico.
OpenAICompatProvider implementado para qualquer endpoint OpenAI-compatible.
Configuração: env SECOND_BRAIN_EXTERNAL_AI_URL + SECOND_BRAIN_EXTERNAL_AI_KEY.
Contexto enviado usa MINIMUM NECESSARY CONTEXT com redação de secrets.
