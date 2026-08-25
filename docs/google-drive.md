# Google Drive — arquivo de artifacts dos agentes

Os agentes arquivam automaticamente o que produzem no Google Drive
(conta `wmagenciasuporte@gmail.com`), na pasta **Secom**.

## Estrutura criada

```
Secom/
  imagens/24-08-26/logo-clinica.png        <- imagens vão direto na pasta da data
  videos/24-08-26/promo-nutriva.mp4        <- vídeos gerados (Pollinations)
  campanhas/black-friday-2026/24-08-26/brief.txt
  prospeccoes/clinicas-nutricao/25-08-26/leads.csv
  projetos/<nome-do-projeto>/registro.txt  <- um registro por projeto de software
```

- `imagens/<data>/arquivo` — imagens geradas pelo Designer (Pollinations FLUX).
- `videos/<data>/arquivo` — vídeos gerados pelo Designer (Pollinations gen API).
- `<categoria>/<nome-da-coisa>/<data>/arquivo` — campanhas, prospecções, relatórios etc.
- `projetos/<nome>/registro.txt` — registro estável por projeto: link, login (master), senha, status.
- Datas usam hífens (`24-08-26`) porque o Drive para Windows não sincroniza pastas com `/`.

## Setup (uma vez, ~5 min)

1. Acesse https://console.cloud.google.com com `wmagenciasuporte@gmail.com`.
2. Crie um projeto (ex.: `second-brain-os`).
3. Ative a **Google Drive API** (APIs & Services > Library).
4. IAM & Admin > Service Accounts > Create Service Account (sem papéis).
   Em Keys > Add Key > JSON — baixe o arquivo.
5. No Google Drive, clique com o botão direito na pasta **Secom** >
   Compartilhar > compartilhe com o e-mail da service account
   (`xxx@yyy.iam.gserviceaccount.com`) como **Editor**.

## Configuração

Local — `.env.local`:
```
GOOGLE_DRIVE_SA_EMAIL=xxx@yyy.iam.gserviceaccount.com
GOOGLE_DRIVE_SA_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```
(ou aponte `GOOGLE_DRIVE_SA_FILE=caminho/do/arquivo.json`)

Railway — variáveis `GOOGLE_DRIVE_SA_EMAIL`, `GOOGLE_DRIVE_SA_KEY`,
`GOOGLE_DRIVE_ROOT_FOLDER=Secom`.

Opcional: `GOOGLE_DRIVE_ROOT_FOLDER` muda a pasta raiz (padrão `Secom`).

## Ferramentas expostas aos agentes

| Tool | Uso |
|---|---|
| `image_generate` | Gera imagem + arquiva em `imagens/<data>/` + retorna link do Drive |
| `drive_upload` | Arquiva qualquer arquivo em `<categoria>/<nome>/<data>/` |

Agentes com permissão: Designer, Marketing, Prospector.

## Validação

```bash
npx tsx scripts/test-drive.ts
```

Sem credenciais configuradas, as tools retornam `NOT_CONFIGURED` — os agentes
continuam funcionando (só não arquivam no Drive).
