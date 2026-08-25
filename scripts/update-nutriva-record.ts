import { readFileSync } from "node:fs";
import { archiveProjectRecord } from "../core/tools/drive-tools.ts";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const r = await archiveProjectRecord({
  projectName: "Nutriva",
  link: "https://hq-backend-production-4977.up.railway.app/nutriva/",
  login: "master",
  senha: "(definir via variavel NUTRIVA_MASTER_PASSWORD no deploy do produto)",
  status: "MVP-core full-stack - app web no ar",
  notes: [
    "NO AR (25/08/2026): App web completo em /nutriva/ no backend HQ do Railway.",
    "",
    "FRONTEND (design premium, minimalista, sem build step):",
    "- Dashboard com indicadores (pacientes/planos/alimentos/tenants)",
    "- Pacientes: lista + cadastro completo (modal)",
    "- Planos alimentares: montador com autocomplete de alimentos, multi-refeicoes,",
    "  kcal ao vivo por item/refeicao/dia, salvamento persistente no banco",
    "- Substituicoes: busca original + ranking por similaridade com barra visual",
    "- Receitas: ingredientes + porcoes -> total e valor por porcao ao vivo",
    "",
    "BACKEND (codigo primeiro, zero IA nos calculos):",
    "POST /api/plans/full (persistente) | GET /api/plans/:id/full | GET /api/plans |",
    "POST /api/plans/calculate | GET /api/substitutions | POST /api/recipes/calculate |",
    "GET /api/patients | POST /api/patients | GET /api/foods/search | GET /api/dashboard",
    "8 testes vitest passando; volume Railway /app/data persistente.",
    "",
    "Pendente para MVP completo: auth/JWT + Master Admin + RLS, PDFs, WhatsApp, historico/documentos.",
  ].join("\n"),
});

console.log(`status: ${r.status} | path: ${r.path}`);
console.log(`link: ${r.webViewLink ?? r.error}`);
