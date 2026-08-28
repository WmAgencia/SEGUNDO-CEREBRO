#!/usr/bin/env node
/**
 * Script de teste de conexão com Evolution API
 * Uso: node scripts/test-evolution-connection.ts
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

const BASE_URL = process.env.EVOLUTION_API_URL;
const API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || "SECOM";
const OWNER_PHONE = process.env.OWNER_WHATSAPP || "5515981817336";

async function evoRequest(method, endpoint, body) {
  const url = `${BASE_URL}${endpoint}`;
  console.log(`\n📡 ${method} ${url}`);

  const res = await fetch(url, {
    method,
    headers: {
      apikey: API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  console.log(`   Status: ${res.status}`);
  console.log(`   Response: ${JSON.stringify(json, null, 2).slice(0, 500)}`);

  return { status: res.status, data: json };
}

async function testConnection() {
  console.log("=".repeat(60));
  console.log("🔍 TESTE DE CONEXÃO COM EVOLUTION API");
  console.log("=".repeat(60));

  console.log(`\n📋 Configuração:`);
  console.log(`   URL: ${BASE_URL}`);
  console.log(`   API Key: ${API_KEY ? API_KEY.slice(0, 8) + "..." : "NÃO CONFIGURADA"}`);
  console.log(`   Instance: ${INSTANCE}`);
  console.log(`   Owner Phone: ${OWNER_PHONE}`);

  if (!BASE_URL || !API_KEY) {
    console.log("\n❌ ERRO: EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados!");
    console.log("   Edite o arquivo .env.local");
    process.exit(1);
  }

  try {
    // 1. Testar fetching de instâncias
    console.log("\n\n📡 TESTE 1: Buscando instâncias...");
    const instances = await evoRequest("GET", "/instance/fetchInstances");

    if (instances.status !== 200) {
      console.log("\n❌ ERRO: Não foi possível conectar à Evolution API");
      process.exit(1);
    }

    const instanceList = Array.isArray(instances.data) ? instances.data : [];
    console.log(`\n✅ Encontradas ${instanceList.length} instância(s)`);

    for (const inst of instanceList) {
      console.log(`   - ${inst.name || inst.instanceName}: ${inst.connectionStatus || inst.state || "unknown"}`);
    }

    // 2. Verificar se a instância SECOM existe
    const secOm = instanceList.find(i =>
      (i.name || i.instanceName) === INSTANCE
    );

    if (secOm) {
      console.log(`\n✅ Instância "${INSTANCE}" encontrada!`);
      console.log(`   Status: ${secOm.connectionStatus || secOm.state}`);
    } else {
      console.log(`\n⚠️  Instância "${INSTANCE}" não encontrada`);
      console.log(`   Deseja criar? (futuro)`);
    }

    // 3. Testar envio de mensagem para o owner
    console.log("\n\n📡 TESTE 2: Enviando mensagem de teste...");
    const testMessage = `🤖 *Second Brain OS* - Teste de conexão\n\n` +
      `✅ A Evolution API está funcionando!\n\n` +
      `🕐 ${new Date().toISOString()}\n\n` +
      `Este é um teste automático.`;

    const normalizedOwner = OWNER_PHONE.replace(/\D/g, "");
    const normalizedPhone = normalizedOwner.startsWith("55") ? normalizedOwner : `55${normalizedOwner}`;

    console.log(`   Enviando para: ${normalizedPhone}`);

    try {
      const sendResult = await evoRequest("POST", `/message/sendText/${INSTANCE}`, {
        number: normalizedPhone,
        text: testMessage
      });

      if (sendResult.status === 200 || sendResult.status === 201) {
        console.log("\n✅✅✅ MENSAGEM ENVIADA COM SUCESSO!");
        console.log("   Verifique seu WhatsApp!");
      } else {
        console.log("\n⚠️  Problema ao enviar mensagem");
        console.log(`   Status: ${sendResult.status}`);
      }
    } catch (err) {
      console.log(`\n❌ Erro ao enviar: ${err.message}`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("🏁 TESTES CONCLUÍDOS");
    console.log("=".repeat(60));

  } catch (err) {
    console.error("\n❌ ERRO DE CONEXÃO:", err.message);
    console.error("\nVerifique:");
    console.error("   1. A URL da Evolution API está correta?");
    console.error("   2. A API Key está correta?");
    console.error("   3. A Evolution API está rodando?");
    process.exit(1);
  }
}

testConnection();
