import fs from "node:fs";
const keys = [];
for (const l of fs.readFileSync("C:/Users/junin/second-brain/.env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^GROQ_API_KEY_(\d+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) keys.push({ slot: Number(m[1]), key: m[2].trim() });
}
console.log(`testando ${keys.length} chaves contra a Groq real...\n`);
for (const { slot, key } of keys) {
  const t0 = Date.now();
  try {
    const r = await fetch(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1" + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "responda apenas: ok" }], max_tokens: 30 }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    const ok = r.status === 200;
    console.log(`slot ${slot}: HTTP ${r.status} ${ok ? "✅ CHAVE VÁLIDA (" + (Date.now() - t0) + "ms)" + (content ? " respondeu: " + JSON.stringify(content.slice(0, 30)) : " (content vazio — reasoning)") : "❌ " + (j.error?.message || "").slice(0, 60)}`);
  } catch (e) {
    console.log(`slot ${slot}: ❌ ERRO ${e.message}`);
  }
}
