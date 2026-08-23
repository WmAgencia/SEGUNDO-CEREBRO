# Relatório de Ambiente — FASE 0

Data da inspeção: 2026-08-23
Sistema: Windows 11 Home Single Language (build 10.0.26200), x64

## 1. Resultados da verificação

| Componente | Status | Versão / Detalhe |
|---|---|---|
| Node.js | ✅ OK | v24.18.0 |
| npm | ✅ OK | 11.16.0 |
| bun | ✅ OK (global via npm) | 1.3.14 |
| pnpm | ❌ não instalado | não é necessário |
| Git | ✅ OK | 2.55.0.windows.3 |
| OpenCode | ✅ OK | 1.18.21, config em `~/.config/opencode/opencode.jsonc` |
| Ollama | ❌ não instalado | opcional — sistema NÃO depende dele |
| Obsidian | ✅ instalado | vault detectado automaticamente |
| sqlite3 CLI | ❌ não instalado | **não é necessário** (ver seção 2) |

## 2. Descoberta crítica: `node:sqlite` nativo

Teste executado com sucesso no Node 24.18:

```
node:sqlite (DatabaseSync) + FTS5 + snippet() + bm25() → OK
```

**Decisão arquitetural:** o Second Brain usará o módulo **nativo `node:sqlite`**
em vez de `better-sqlite3`.

Consequências:
- zero dependências nativas (sem node-gyp, sem compilação no Windows);
- zero custo, zero binários externos;
- FTS5 já vem compilado dentro do Node;
- banco 100% reconstruível a partir do Vault.

O CLI `sqlite3` não é necessário; toda operação de banco acontece via Node.

## 3. Vault do Obsidian

Detectado via `%APPDATA%\obsidian\obsidian.json`:

```text
C:\Users\junin\OneDrive\Documentos\Obsidian Vault
```

Estado atual: vault praticamente vazio (`Bem-vindo.md`, um canvas).

Implicações:
- A estrutura inicial (00–99, `_system`) será criada pelo comando `brain init`.
- O vault está dentro do **OneDrive** → risco de sincronização/lock de arquivos
  durante indexação (ver riscos). O índice (`data/brain.db`) ficará FORA do
  OneDrive, no diretório do projeto.
- Configuração via variável de ambiente:
  `SECOND_BRAIN_VAULT=C:\Users\junin\OneDrive\Documentos\Obsidian Vault`

## 4. OpenCode

- Instalado e funcional (v1.18.21).
- Config atual: `C:\Users\junin\.config\opencode\opencode.jsonc`
  (providers AgentRouter + Groq; modelo padrão `groq/openai/gpt-oss-120b`).
- Suporta servidores MCP locais via `"mcp"` no `opencode.json(c)` —
  a sintaxe exata será confirmada na documentação oficial durante a FASE 7.

## 5. Recursos da máquina

| Recurso | Valor |
|---|---|
| RAM total | 15,7 GB (≈4 GB livres no momento) |
| Disco C: | ⚠️ apenas ~2,1 GB livres de 99,5 GB |

⚠️ **Restrição importante:** espaço em disco muito limitado.
- Nada de modelos LLM grandes locais por enquanto (Ollama + modelo ≈ 2–5 GB).
- IA local fica adiada para FASE 8 e só com modelo pequeno se houver espaço.
- Dependências do projeto serão mantidas mínimas.

## 6. Stack escolhida (todas gratuitas/local)

| Camada | Escolha | Custo |
|---|---|---|
| Linguagem | TypeScript (Node 24) | grátis |
| Banco | `node:sqlite` nativo + FTS5 | grátis |
| Parser frontmatter/YAML | `yaml` + parser próprio leve | grátis |
| CLI | `commander` | grátis |
| MCP | `@modelcontextprotocol/sdk` (stdio local) | grátis |
| Testes | `vitest` | grátis |
| IA local (opcional, FASE 8) | Ollama (API compatível c/ OpenAI) | grátis |

Total de dependências runtime: 4 pequenas. Nenhuma paga. Nenhuma cloud obrigatória.

## 7. Riscos técnicos identificados

1. **Espaço em disco (~2 GB livres)** — impede modelos locais grandes agora;
   monitorar em cada fase; manter node_modules enxuto.
2. **Vault em OneDrive** — arquivos podem aparecer parcialmente sincronizados
   ou travados; o indexador deve tolerar erros de leitura individuais
   (pular arquivo + registrar evento) e nunca escrever no vault na V1.
3. **node:sqlite é relativamente novo** — API síncrona e estável no Node 24,
   mas se algo faltar, migrar para `better-sqlite3` é trivial (mesma semântica).
4. **Sintaxe MCP do OpenCode pode mudar** — validar contra docs oficiais na FASE 7.
5. **PowerShell 5.1** — escaping problemático; scripts usarão Node, não shell.

## 8. Conclusão

Ambiente aprovado para iniciar a FASE 1. Nenhum software novo precisa ser
instalado agora. Tudo que a V1 precisa já existe na máquina.
