import { readFileSync } from "node:fs";
import { archiveProjectRecord } from "../core/tools/drive-tools.ts";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const r = await archiveProjectRecord({
  projectName: "Nutriva",
  link: "https://hq-backend-production-4977.up.railway.app/nutriva/api/health",
  login: "master",
  senha: "(definir via variavel NUTRIVA_MASTER_PASSWORD no deploy do produto)",
  status: "MVP-core parcial - API no ar",
  notes: [
    "NO AR (25/08/2026): API deterministica em /nutriva/* no backend HQ do Railway.",
    "Endpoints: /api/health | /api/foods/search | /api/patients (GET/POST) |",
    "/api/plans (GET/POST) | POST /api/plans/calculate | GET /api/substitutions |",
    "POST /api/recipes/calculate.",
    "",
    "Implementado (codigo primeiro, zero IA nos calculos):",
    "- Schema multi-tenant (tenants/users/patients/foods/meal_plans/meals/items)",
    "- Banco de alimentos seed 30 itens com valores nutricionais por referencia",
    "- Motor de calculo proporcional de planos (por item/refeicao/dia)",
    "- Motor de substituicoes algoritmico (similaridade nutricional + balanceamento de proteina)",
    "- Calculadora de receitas (total e por porcao)",
    "- 7 testes vitest passando; deploy Railway persistente (volume /app/data)",
    "",
    "Pendente para MVP completo (spec 37 secoes):",
    "- Auth/JWT + Master Admin + RLS por tenant",
    "- Frontend/design system premium",
    "- PDFs (plano/receita/substituicoes)",
    "- Integracao WhatsApp (evolution API)",
    "- Historico/documentos por paciente",
  ].join("\n"),
});

console.log(`status: ${r.status} | path: ${r.path}`);
console.log(`link: ${r.webViewLink ?? r.error}`);
