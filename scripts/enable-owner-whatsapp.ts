#!/usr/bin/env node
/**
 * Script para ativar o agente pessoal e testar a conversa via WhatsApp
 *
 * Uso: node scripts/enable-owner-whatsapp.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = path.resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

const OWNER_PHONE = (process.env.OWNER_WHATSAPP || "5515981817336").replace(/\D/g, "");
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || "SECOM";

async function evoRequest(method, endpoint, body) {
  const url = `${EVOLUTION_API_URL}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log("=".repeat(60));
  console.log("🤖 ATIVAÇÃO DO AGENTE WHATSAPP PARA OWNER");
  console.log("=".repeat(60));

  console.log(`\n📋 Configuração:`);
  console.log(`   Owner Phone: ${OWNER_PHONE}`);
  console.log(`   Instance: ${INSTANCE}`);

  // 1. Testar conexão
  console.log("\n📡 Testando conexão com Evolution API...");
  try {
    const instances = await evoRequest("GET", "/instance/fetchInstances");
    const secOm = (instances.data || []).find(i =>
      (i.name || i.instanceName) === INSTANCE
    );

    if (secOm) {
      console.log(`   ✅ Instância "${INSTANCE}" encontrada`);
      console.log(`   Status: ${secOm.connectionStatus || secOm.state}`);

      if (secOm.connectionStatus === "open" || secOm.state === "open") {
        console.log(`   ✅ WhatsApp conectado!`);
      } else {
        console.log(`   ⚠️ WhatsApp não conectado. Escaneie o QR code primeiro.`);
      }
    } else {
      console.log(`   ⚠️ Instância "${INSTANCE}" não encontrada`);
    }
  } catch (err) {
    console.log(`   ❌ Erro: ${err.message}`);
    return;
  }

  // 2. Enviar mensagem de teste
  const testMessage = `🤖 *Second Brain OS*\n\n` +
    `✅ Agente WhatsApp configurado!\n\n` +
    `A partir de agora você pode me enviar mensagens aqui no WhatsApp e eu vou responder!\n\n` +
    `Me mande uma tarefa, pergunta ou qualquer coisa que eu te ajudo.\n\n` +
    `🕐 ${new Date().toLocaleString("pt-BR")}`;

  console.log("\n📤 Enviando mensagem de ativação...");
  try {
    const send = await evoRequest("POST", `/message/sendText/${INSTANCE}`, {
      number: OWNER_PHONE.startsWith("55") ? OWNER_PHONE : `55${OWNER_PHONE}`,
      text: testMessage
    });

    if (send.status === 200 || send.status === 201) {
      console.log("   ✅ Mensagem enviada com sucesso!");
      console.log("   ✅ Verifique seu WhatsApp!");
    } else {
      console.log(`   ⚠️ Status: ${send.status}`);
      console.log(`   Resposta: ${JSON.stringify(send.data)}`);
    }
  } catch (err) {
    console.log(`   ❌ Erro ao enviar: ${err.message}`);
  }

  // 3. Instruções
  console.log("\n" + "=".repeat(60));
  console.log("📝 PRÓXIMOS PASSOS");
  console.log("=".repeat(60));
  console.log(`
1. ✅ Mensagem de teste enviada para seu WhatsApp

2. 🔄 Para ativar o fluxo completo de resposta:
   - Vá no painel da Evolution API
   - Configure o webhook para: https://hq-backend-production-ff4f.up.railway.app/webhooks/evolution
   - Eventos: MESSAGES_UPSERT, CONNECTION_UPDATE

3. 💬 Para testar:
   - Me mande uma mensagem no WhatsApp
   - O sistema vai receber e processar
   - Eu vou responder automaticamente!

4. 📋 Tipos de mensagem que eu posso ajudar:
   - Tarefas e lembretes
   - Pesquisas e informações
   - Anotações e organização
   - Consultas no Second Brain
   - E muito mais!
`);

  console.log("\n🎉 Configuração concluída!");
}

main().catch(console.error);
