# TOOL EXECUTION LAYER (Fase 20)

## Fluxo

```
Agent → requestExecution → Policy → [ALLOWED|BLOCKED|REQUIRES_APPROVAL]
→ runAuthorizedExecution → LocalExecutor → Result → Validation → Agent Result
```

## Estados
REQUESTED → AUTHORIZED → RUNNING → COMPLETED/FAILED/TIMED_OUT/BLOCKED/CANCELLED
REQUIRES_APPROVAL → (humano) → AUTHORIZED ou CANCELLED

## Risk Levels
LOW: leitura/pesquisa. MEDIUM: escrita local. HIGH: envio/publicação. CRITICAL: gastos/exclusões.

## Idempotency
idempotency_key UNIQUE previne execução duplicada.

## Retry
Transient errors (timeout, ECONNREFUSED) fazem retry até max_retries. Permanentes falham direto.
