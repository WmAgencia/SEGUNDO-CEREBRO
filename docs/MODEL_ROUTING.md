# Model Routing

`core/ai/model-router.ts` adiciona uma camada opcional sobre o `LLMProvider`
existente.

## Fluxo

```
agent/task/workload → selectModel → provider + model + fallbacks
                    → OpenRouterProvider (opcional)
                    → model_generations (tokens/cost/latency/status)
```

Workloads suportados: `fast`, `chat`, `reasoning`, `research`, `coding`,
`vision` e `image`. O router é determinístico e pode ser sobrescrito por
`SECOND_BRAIN_MODEL` e `SECOND_BRAIN_MODEL_PROVIDER`.

OpenRouter usa `POST /api/v1/chat/completions`, `models` + `route: fallback`,
tool/structured-output compatíveis e usage nativo. Sem
`OPENROUTER_API_KEY`, o provider falha explicitamente e o sistema local não é
bloqueado.

Não foi adicionado `@openrouter/sdk`: o projeto já possui abstração e `fetch`,
e a SDK oficial ainda é beta. Fallback local continua possível por injeção de
providers.
