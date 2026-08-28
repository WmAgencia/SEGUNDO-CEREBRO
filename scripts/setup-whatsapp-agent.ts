/**
 * Script para configurar o agente WhatsApp
 *
 * Este script configura um agente especial que pode receber mensagens
 * do WhatsApp e respondê-las usando o Second Brain.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");

// Load .env.local
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

const OWNER_PHONE = process.env.OWNER_WHATSAPP || "5515981817336";
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || "SECOM";

console.log("=".repeat(60));
console.log("🤖 CONFIGURAÇÃO DO AGENTE WHATSAPP");
console.log("=".repeat(60));

console.log(`
Este script configura o Second Brain para se comunicar com você
via WhatsApp usando a Evolution API.

CONFIGURAÇÃO ATUAL:
- URL: ${EVOLUTION_API_URL}
- Instance: ${INSTANCE}
- Owner Phone: ${OWNER_PHONE}

PRÓXIMOS PASSOS:
1. Configurar webhook na Evolution API
2. Reiniciar o backend do Second Brain
3. Testar o fluxo completo

WEBHOOK URL:
O webhook da Evolution API deve apontar para:
${EVOLUTION_API_URL}/webhook/wa/${INSTANCE}

Ou se você tem um backend separado:
https://seu-backend.up.railway.app/webhook/wa/${INSTANCE}
`);

// Verificar conexão com Evolution API
async function testEvolutionConnection() {
  console.log("\n📡 Testando conexão com Evolution API...");

  try {
    const res = await fetch(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
      headers: {
        apikey: EVOLUTION_API_KEY,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.log("❌ Erro ao conectar:", res.status);
      return false;
    }

    const instances = await res.json();
    console.log("✅ Conexão OK!");
    console.log("\nInstâncias encontradas:");
    for (const inst of Array.isArray(instances) ? instances : []) {
      console.log(`  - ${inst.name}: ${inst.connectionStatus || inst.state}`);
    }

    return true;
  } catch (err) {
    console.log("❌ Erro:", err.message);
    return false;
  }
}

// Listar webhooks configurados
async function listWebhooks() {
  console.log("\n📋 Listando webhooks...");

  try {
    const res = await fetch(`${EVOLUTION_API_URL}/webhook/find/${INSTANCE}`, {
      headers: {
        apikey: EVOLUTION_API_KEY,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const webhooks = await res.json();
      console.log("Webhooks configurados:");
      console.log(JSON.stringify(webhooks, null, 2));
    } else {
      console.log("⚠️ Não foi possível listar webhooks (status:", res.status, ")");
    }
  } catch (err) {
    console.log("⚠️ Erro ao listar webhooks:", err.message);
  }
}

// Criar webhook para receber mensagens
async function createWebhook(webhookUrl) {
  console.log("\n📝 Criando webhook...");

  try {
    const res = await fetch(`${EVOLUTION_API_URL}/webhook/set/${INSTANCE}`, {
      method: "POST",
      headers: {
        apikey: EVOLUTION_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook: {
          url: webhookUrl,
          enabled: true,
          events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      console.log("✅ Webhook criado com sucesso!");
    } else {
      const text = await res.text();
      console.log("⚠️ Erro ao criar webhook:", text);
    }
  } catch (err) {
    console.log("⚠️ Erro ao criar webhook:", err.message);
  }
}

async function main() {
  const connected = await testEvolutionConnection();

  if (connected) {
    await listWebhooks();

    console.log("\n" + "=".repeat(60));
    console.log("INSTRUÇÕES DE CONFIGURAÇÃO");
    console.log("=".repeat(60));

    console.log(`
1. WEBHOOK NA EVOLUTION API:
   Acesse o painel da Evolution API e configure um webhook:

   URL do webhook: https://seu-segundo-brain.up.railway.app/webhook/wa/SECOM
   (substitua pela URL real do seu backend)

   Eventos: MESSAGES_UPSERT, CONNECTION_UPDATE

2. BACKEND DO SECOND BRAIN:
   O backend precisa estar rodando e acessível publicamente.
   O endpoint do webhook é: /webhook/wa/{instance}

3. VARIÁVEIS DE AMBIENTE:
   SECOND_BRAIN_VAULT=${process.env.SECOND_BRAIN_VAULT}
   SECOND_BRAIN_DATA_DIR=${process.env.SECOND_BRAIN_DATA_DIR}
   `);
  }
}

main().catch(console.error);
