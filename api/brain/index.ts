/**
 * Brain endpoint - Claude (via Nexxus) + Obsidian context + WhatsApp.
 *
 * This is the core agent that talks to the user.
 * It has access to:
 * - Obsidian vault (read-only via the MCP tool's brain_context equivalent)
 * - Memory of previous conversations
 * - Project knowledge (Nutriva, ClipCom, Vyntra, Consecom)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

// Try to load Obsidian vault from common locations
const VAULT_PATHS = [
  process.env.SECOND_BRAIN_VAULT,
  'C:/Users/junin/OneDrive/Documentos/Obsidian Vault',
  'C:/Users/junin/OneDrive/Documentos/ObsidianVault',
  'C:/Users/junin/ObsidianVault',
];

interface ObsidianFile {
  path: string;
  title: string;
  content: string;
}

function findVaultPath(): string | null {
  for (const p of VAULT_PATHS) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

async function downloadVaultFromGitHub(): Promise<{ context: string; files: number } | null> {
  const repo = process.env.OBSIDIAN_VAULT_REPO;
  const token = process.env.OBSIDIAN_VAULT_TOKEN;

  if (!repo || !token) return null;

  try {
    // Get file tree from GitHub API
    const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'second-brain' },
    });
    if (!treeRes.ok) return null;
    const tree = await treeRes.json() as { tree: Array<{ path: string; type: string; sha: string }> };

    // Get priority files (limit to top 30 for performance)
    const mdFiles = tree.tree
      .filter((f) => f.type === 'blob' && f.path.endsWith('.md') && !f.path.startsWith('.'))
      .slice(0, 30);

    const files: ObsidianFile[] = [];
    for (const f of mdFiles) {
      try {
        const contentRes = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'second-brain' },
        });
        if (!contentRes.ok) continue;
        const fileData = await contentRes.json() as { content?: string; name?: string };
        if (fileData.content) {
          const content = Buffer.from(fileData.content, 'base64').toString('utf8').slice(0, 2000);
          files.push({
            path: f.path,
            title: f.path.split('/').pop()?.replace(/\.md$/, '') ?? f.path,
            content,
          });
        }
      } catch {}
    }

    let context = '';
    let count = 0;
    for (const f of files) {
      const chunk = `\n\n[${f.path}]\n${f.content}`;
      if (context.length + chunk.length > 8000) break;
      context += chunk;
      count++;
    }

    return { context, files: count };
  } catch {
    return null;
  }
}

function readVaultContext(vaultPath: string, maxChars = 8000): { context: string; files: number } {
  try {
    const files: ObsidianFile[] = [];

    function walk(dir: string, depth = 0): void {
      if (depth > 4) return; // Limit depth
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            try {
              const content = readFileSync(full, 'utf8').slice(0, 2000); // Truncate each file
              const relativePath = path.relative(vaultPath, full).replace(/\\/g, '/');
              files.push({ path: relativePath, title: entry.name.replace(/\.md$/, ''), content });
            } catch {}
          }
        }
      } catch {}
    }

    walk(vaultPath);

    // Sort by recent / prioritize key folders
    const priority = (f: ObsidianFile) => {
      const p = f.path.toLowerCase();
      if (p.includes('00 - inbox')) return 5;
      if (p.includes('01 - me')) return 4;
      if (p.includes('02 - core')) return 4;
      if (p.includes('03 - projects')) return 3;
      if (p.includes('projects')) return 3;
      if (p.includes('areas')) return 2;
      if (p.includes('knowledge')) return 2;
      if (p.includes('conversations')) return 2;
      return 1;
    };
    files.sort((a, b) => priority(b) - priority(a));

    // Take top files within budget
    let context = '';
    let count = 0;
    for (const f of files) {
      const chunk = `\n\n[${f.path}]\n${f.content}`;
      if (context.length + chunk.length > maxChars) break;
      context += chunk;
      count++;
    }

    return { context, files: count };
  } catch (err) {
    return { context: '', files: 0 };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __vaultContextCache: { context: string; files: number; loadedAt: number; source: string } | undefined;
}

async function getObsidianContext(): Promise<{ context: string; files: number; source: string }> {
  // Cache for 5 minutes
  if (globalThis.__vaultContextCache && Date.now() - globalThis.__vaultContextCache.loadedAt < 300_000) {
    return {
      context: globalThis.__vaultContextCache.context,
      files: globalThis.__vaultContextCache.files,
      source: globalThis.__vaultContextCache.source,
    };
  }

  // Try GitHub first (works in Vercel)
  const githubResult = await downloadVaultFromGitHub();
  if (githubResult && githubResult.files > 0) {
    globalThis.__vaultContextCache = { ...githubResult, loadedAt: Date.now(), source: 'github' };
    return { ...githubResult, source: 'github' };
  }

  // Fallback to local disk (works in dev)
  const vaultPath = findVaultPath();
  if (vaultPath) {
    const result = readVaultContext(vaultPath);
    globalThis.__vaultContextCache = { ...result, loadedAt: Date.now(), source: 'local' };
    return { ...result, source: 'local' };
  }

  return { context: '', files: 0, source: 'none' };
}

async function callClaude(userMessage: string, conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<string> {
  const vault = await getObsidianContext();

  const systemPrompt = `Você é o Second Brain OS, assistente pessoal do Junin (Wesley Rocha Santos Junior).

Sobre o Junin:
- Brasileiro, fala português
- Trabalha com desenvolvimento e IA
- Projetos: Nutriva (nutrição), ClipCom (clipping), Vyntra, Consecom (publicidade)
- Salva notas no Obsidian Vault
- Comunica via WhatsApp pessoal (5515981817336)

Diretrizes de resposta:
- Responda SEMPRE em português do Brasil
- Seja conciso (WhatsApp tem limite de leitura)
- Use emojis com moderação
- Converse natural, como um parceiro humano
- Não use markdown pesado (WhatsApp não renderiza)
- Se não souber algo, diga honestamente
- Use o contexto do Obsidian quando relevante

Contexto do Obsidian Vault (${vault.files} notas relevantes):
${vault.context || '(nenhuma nota acessível)'}`.trim();

  const res = await fetch(`${ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [...conversationHistory, { role: 'user', content: userMessage }],
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Claude ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.filter((c: { type: string; text?: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
  return text || '';
}

async function sendWhatsApp(toNumber: string, text: string): Promise<{ messageId: string }> {
  let normalized = toNumber.replace(/\D/g, '');
  // Map LID to real phone for Evolution API
  if (normalized === '189494074573054') {
    normalized = '5515981817336';
  } else if (normalized.length === 11 && !normalized.startsWith('55')) {
    normalized = `55${normalized}`;
  }

  const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: normalized, text }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Evolution ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return { messageId: data.key?.id ?? 'unknown' };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Health check
  if (req.method === 'GET') {
    const vault = await getObsidianContext();
    res.status(200).json({
      ok: true,
      model: ANTHROPIC_MODEL,
      vault_files: vault.files,
      vault_source: vault.source,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { message?: string; from?: string };
    const message = (body?.message ?? '').trim();
    const from = (body?.from ?? OWNER_PHONE).replace(/\D/g, '');

    if (!message) {
      res.status(400).json({ ok: false, error: 'message required' });
      return;
    }

    // Owner can be: OWNER_PHONE, 5515981817336, or LID 189494074573054
    const ownerDigits = OWNER_PHONE.replace(/\D/g, '');
    const ownerLid = '189494074573054';
    const isOwner =
      from === ownerDigits ||
      from === ownerLid ||
      from === `55${ownerDigits}` ||
      from.endsWith(ownerDigits);

    if (!isOwner) {
      res.status(200).json({ ok: true, action: 'skipped:not_owner', from });
      return;
    }

    const reply = await callClaude(message);
    if (!reply) throw new Error('Empty Claude response');

    const sent = await sendWhatsApp(from, reply);

    res.status(200).json({
      ok: true,
      messageId: sent.messageId,
      reply_preview: reply.slice(0, 200),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}