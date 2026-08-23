# Reconstruindo o Second Brain do zero

O `data/brain.db` é **descartável por design**: todo o estado derivado
(índice, busca, grafo, entidades) é reconstruído a partir do Obsidian Vault.

## O que é essencial (backup de verdade)

| Item | Onde | Por quê |
|---|---|---|
| **Obsidian Vault** | `C:\Users\junin\OneDrive\Documentos\Obsidian Vault` | A única fonte de verdade |
| Config OpenCode | `%USERPROFILE%\.config\opencode\opencode.jsonc` | Providers + MCP + agente brain |
| Este repositório | `C:\Users\junin\second-brain` | Código (versionável via git) |

**Não precisa de backup:** `data/brain.db`, `data/brain.db-*`,
`tools/llamacpp/`, `tools/models/` — tudo re-baixável/reconstruível.

## Procedimento completo de reconstrução

### 1. Dependências

- Node.js ≥ 24 (o banco usa o `node:sqlite` nativo)
- No diretório do projeto: `npm install`

### 2. Recriar o índice

```powershell
$env:SECOND_BRAIN_VAULT = "C:\Users\junin\OneDrive\Documentos\Obsidian Vault"
npm run cli -- init      # cria estrutura faltante no vault + banco novo
npm run cli -- index     # indexa tudo do zero (~1s para vaults pequenos)
```

Se o vault já tiver a estrutura `00–99/_system`, o `init` só confirma e não
sobrescreve nada. Notas com frontmatter `id:` viram entidades; links
`[[...]]` e blocos `relations:` viram arestas do grafo.

### 3. IA local opcional

- Runtime: baixe o zip *win-cpu* mais recente de
  <https://github.com/ggml-org/llama.cpp/releases> e extraia em
  `tools\llamacpp`
- Modelo: `Qwen3-1.7B-Q4_K_M.gguf` em
  <https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF> → salve em
  `tools\models\qwen3-1.7b-q4_k_m.gguf`
  (se huggingface.co servir HTML, use o espelho hf-mirror.com)
- Teste: `npm run llama:serve` + `npm run ai:status`

### 4. Reconectar o OpenCode

```powershell
opencode mcp list        # deve mostrar: ✓ second-brain connected
opencode run --agent brain "O que você sabe sobre o Vyntra?"
```

## Verificação de integridade pós-reconstrução

```powershell
npm run cli -- doctor    # node, vault, banco, disco
npm run cli -- stats     # contagens > 0
npm run cli -- search "vendas"   # deve retornar hits
```

## Memórias manuais (única exceção)

Memórias criadas por `brain_remember` / `ai:extract --save` vivem SÓ no
banco (fonte `conversation`) — **não são reconstruídas do vault**. Se elas
importarem, exporte antes:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/brain.db');console.log(JSON.stringify(db.prepare('SELECT memory_kind,category,content,entity_id,confidence FROM memories').all(),null,2))" > backup-memories.json
```

Para restaurar depois, reinsira via `brain_remember` ou SQL equivalente.
