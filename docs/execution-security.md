# EXECUTION POLICY & SECURITY

## Política de execução (determinística)

Antes de qualquer tool executar:
1. agente existe e está ativo
2. iniciativa APPROVED/RUNNING (se vinculada)
3. tool registrada e disponível
4. permissão do agente ≥ risco da tool
5. projeto autorizado (se declarado)
6. HIGH/CRITICAL → REQUIRES_APPROVAL

## Classificação de risco

| Nível | Critério | Permissão |
|---|---|---|
| LOW | READ, search, analysis | READ |
| MEDIUM | WRITE local, automation | WRITE |
| HIGH | external, EXECUTE | EXECUTE |
| CRITICAL | ADMIN, DELETE | ADMIN |

## Secrets
`redactSecrets()` remove padrões gsk_*, sk-*, Bearer, api_key=, password= de
outputs antes de persistir. `redactDeep()` aplica recursivamente em objetos.

## Contexto externo
MINIMUM NECESSARY CONTEXT: apenas pieces relevantes, cap 2000 chars cada,
secrets redigidos. O vault completo nunca é enviado para APIs externas.
