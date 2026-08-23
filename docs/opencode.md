# Second Brain + OpenCode — Guia de Integração

## 1. Visão geral

O OpenCode conversa com o Second Brain via **MCP local (stdio)**:

```text
OpenCode ──spawn──> node mcp/src/main.ts ──> brain.db (SQLite) ←─ VaultIndexer ←── Obsidian Vault
```

Nome registrado na config: **`second-brain`**.
As ferramentas ficam disponíveis ao LLM como `second-brain_*`.

## 2. Pré-requisitos

- Node.js ≥ 24 (`node -v`)
- Segundo Brain instalado em `C:\Users\junin\second-brain` (deps: `npm install`)
- Vault indexado pelo menos uma vez:
  ```powershell
  $env:SECOND_BRAIN_VAULT = "C:\Users\junin\OneDrive\Documentos\Obsidian Vault"
  npm run cli -- init     # só na primeira vez
  npm run cli -- index    # reindexa sempre que quiser
  ```

## 3. Configuração do OpenCode

Arquivo: `%USERPROFILE%\.config\opencode\opencode.jsonc`
(backup automático criado em `opencode.jsonc.bak-second-brain`)

Bloco adicionado dentro do objeto raiz:

```jsonc
{
  "mcp": {
    "second-brain": {
      "type": "local",
      "command": ["node", "C:\\Users\\junin\\second-brain\\mcp\\src\\main.ts"],
      "environment": {
        "SECOND_BRAIN_VAULT": "C:\\Users\\junin\\OneDrive\\Documentos\\Obsidian Vault"
      },
      "enabled": true,
      "timeout": 10000
    }
  }
}
```

Sintaxe validada contra a documentação oficial (opencode.ai/docs/mcp-servers):
`type:"local"` + `command:[...]` + opcionalmente `environment`, `enabled`, `cwd`,
`timeout`. Mudanças de sintaxe devem ser conferidas nessa página antes de alterar.

## 4. Agente `brain` (configurado)

Além do MCP, o config registra um **agente primário `brain`** que usa o
modelo gratuito `opencode/nemotron-3-ultra-free` (Zen) com prompt curto
dedicado à consulta do cérebro. Isso contorna o limite de TPM do plano
gratuito do Groq (o prompt padrão Build do OpenCode tem ~32k tokens; o
limite free do Groq para gpt-oss é 8K TPM — inviável).

```jsonc
"agent": {
  "brain": {
    "description": "Second Brain: responde usando as ferramentas brain_*",
    "mode": "primary",
    "model": "opencode/nemotron-3-ultra-free",
    "permission": { "edit": "deny", "bash": "deny" },
    "prompt": "...(consulta só via second-brain_*, cita fontes, PT-BR)..."
  }
}
```

## 5. Verificar e usar

```powershell
opencode mcp list        # ✓ second-brain connected

# Sessão interativa:
opencode --agent brain
# ou pontual:
opencode run --agent brain "O que você sabe sobre o Vyntra?"
```

Perguntas de teste (todas validadas em sessão real):

```text
O que você sabe sobre o Vyntra?
Quais outros projetos estão relacionados ao Vyntra?
Qual foi a decisão sobre campanhas do Vyntra?
Monte o contexto necessário para trabalhar no Vyntra hoje.
Registre que prefiro respostas curtas (brain_remember)
```

Dica da doc oficial: citar o nome do MCP no prompt ajuda o LLM a escolher
a ferramenta ("use o second-brain").

## 6. Ferramentas expostas

| Tool | Leitura/Escrita | Descrição |
|---|---|---|
| `brain_search` | leitura | busca lexical c/ bm25, snippet, filtros type/tag/path |
| `brain_resolve` | leitura | texto → entidade mais provável (+ candidatos) |
| `brain_get` | leitura | entidade por id/alias/nome + estatísticas |
| `brain_related` | leitura | grafo: direção, profundidade 1–5, tipos, validez temporal |
| `brain_context` | leitura | contexto consolidado c/ orçamento de caracteres |
| `brain_timeline` | leitura | histórico: eventos, relações, documento, memórias |
| `brain_sources` | leitura | provenance de uma entidade ou lista global |
| `brain_remember` | escrita* | registra memória (episodic/semantic/procedural/decision/relational) |
| `brain_link` | escrita* | cria relação entre entidades existentes |
| `brain_health` | leitura | contagens, última indexação, versão de schema |

\* Escrita **apenas no índice** (`data/brain.db`), fonte registrada como
`conversation`. O vault Obsidian **nunca** é modificado pelas ferramentas.

Formato de resposta: JSON textual em `content[0].text`.
Erros do cérebro: `{error, code, message}` com `isError:true`.
Erros de schema zod: mensagem do próprio SDK.

## 7. Troubleshooting

### 7.1 `✗ second-brain failed` ou timeout

- Teste o servidor manualmente:
  ```powershell
  $env:SECOND_BRAIN_VAULT = "C:\Users\junin\OneDrive\Documentos\Obsidian Vault"
  node C:\Users\junin\second-brain\mcp\src\main.ts
  ```
  Deve ficar aguardando stdin sem printar nada (logs vão para stderr).
  Ctrl+C para sair. Se printar erro, corrija o caminho/env.
- Aumente `"timeout"` para 20000.
- Confirme que `npm install` foi rodado no diretório do projeto.

### 7.2 Tools respondem `{ok:false, reason:"database not initialized"}`

Rode `npm run cli -- init` e depois `index` (o banco não existe ainda).

### 7.3 `Request too large ... Limit 8000 TPM` (Groq gratuito)

O prompt padrão Build do OpenCode tem ~32k tokens; o plano gratuito do Groq
limita gpt-oss/qwen a 8K TPM — nenhum request passa. Soluções, em ordem:
1. **Usar o agente `brain`** (já configurado): ele usa
   `opencode/nemotron-3-ultra-free` (Zen, sem chave, suporta tools).
   `opencode run --agent brain "..."`
2. Groq Dev tier (pago) se precisar do gpt-oss-120b via Groq.
3. Outro provider com tool-calling e TPM alto no opencode.jsonc.

`groq/compound` e `compound-mini` têm 70K TPM mas NÃO suportam tool-calling
externo — inúteis para MCP.

### 7.4 Respostas desatualizadas

O agente lê o ÍNDICE. Reindexe após editar notas:
```powershell
$env:SECOND_BRAIN_VAULT = "..."; npm run cli -- index
# ou deixe observando:
npm run cli -- watch
```

### 7.5 Múltiplos vaults

Um `brain.db` por vault. Para outro vault, use outro
`SECOND_BRAIN_DATA_DIR` no bloco `environment` do respectivo server.

## 8. Como reconstruir o cérebro do zero

1. Feche OpenCode (libera o db).
2. Apague `second-brain\data\brain.db*` (é derivável — seguro).
3. `npm run cli -- init && npm run cli -- index`.
4. `opencode mcp list` → deve reconectar.
