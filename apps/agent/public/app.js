(function () {
  "use strict";

  const API = (window.SECOND_BRAIN_API ? window.SECOND_BRAIN_API.replace(/\/$/, "") : "");
  let currentSession = null;
  let pendingApproval = null;
  let graphPollers = new Map();
  let waPollTimer = null;
  let attachedFile = null;

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, body, method) {
    const res = await fetch(API + path, {
      method: body ? (method || "POST") : (method || "GET"),
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  // ── Tema (claro/escuro/sistema) ──
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("sb-theme", t); } catch {}
    $("#theme-ico").textContent = t === "dark" ? "🌙" : t === "light" ? "☀" : "◐";
  }
  function cycleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") || "system";
    applyTheme(cur === "system" ? "light" : cur === "light" ? "dark" : "system");
  }
  try { applyTheme(localStorage.getItem("sb-theme") || "system"); } catch { applyTheme("system"); }
  $("#btn-theme").addEventListener("click", cycleTheme);

  // ── Views ──
  function showView(name) {
    ["chat", "graphs", "images", "agenda", "connections", "routing"].forEach((v) => {
      const el = $("#view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    if (name === "graphs") loadGraphsPanel();
    if (name === "images") loadImages();
    if (name === "agenda") loadAgenda();
    if (name === "connections") loadConnections();
    if (name === "routing") loadRouting();
    closeDrawer();
  }
  document.querySelectorAll(".sb-item").forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.view));
  });

  // drawer mobile
  function openDrawer() {
    document.querySelector(".app").classList.add("drawer-open");
    $("#sidebar-backdrop").classList.remove("hidden");
  }
  function closeDrawer() {
    document.querySelector(".app").classList.remove("drawer-open");
    $("#sidebar-backdrop").classList.add("hidden");
  }
  $("#btn-menu").addEventListener("click", openDrawer);
  $("#sidebar-backdrop").addEventListener("click", closeDrawer);
  $("#btn-collapse").addEventListener("click", () => document.querySelector(".app").classList.toggle("collapsed"));

  // ── Markdown (leve, sem dependências) ──
  function renderMarkdown(text) {
    let src = String(text ?? "");
    const blocks = [];
    src = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push('<pre><code data-lang="' + esc(lang) + '">' + esc(code) + "</code></pre>");
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });
    let html = esc(src);
    html = html.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/^\s*[-•] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.split(/\n{2,}/).map((p) => {
      if (/^<(h[123]|ul|pre|blockquote|li)/.test(p.trim())) return p;
      return "<p>" + p.replace(/\n/g, "<br/>") + "</p>";
    }).join("\n");
    html = html.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)] || "");
    return html;
  }

  // ── Mensagens ──
  function hideHero() { const h = $("#empty-hero"); if (h) h.remove(); }

  function addUserMessage(text) {
    hideHero();
    const row = document.createElement("div");
    row.className = "msg-row";
    row.innerHTML = '<div class="avatar user">V</div><div class="msg-body"><div class="md">' + renderMarkdown(text) + "</div></div>";
    $("#messages").appendChild(row);
    scrollBottom();
  }

  function addAgentMarkdown(text) {
    const row = document.createElement("div");
    row.className = "msg-row";
    row.innerHTML = '<div class="avatar agent">SB</div><div class="msg-body"><div class="md">' + renderMarkdown(text) + "</div></div>";
    $("#messages").appendChild(row);
    scrollBottom();
    return row;
  }

  function addStatusLine(stage) {
    const div = document.createElement("div");
    div.className = "status-line";
    div.innerHTML = '<span class="spinner"></span><span>' + esc(stage) + "</span>";
    $("#messages").appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom() { const box = $("#messages"); box.scrollTop = box.scrollHeight; }

  // ── Tool cards (representação amigável, sem dados técnicos) ──
  const TOOL_LABELS = {
    web_search: ["🔎", "Pesquisa na web"],
    web_fetch: ["🔎", "Lendo página da web"],
    brain_search: ["🧠", "Consultando o Second Brain"],
    memory_search: ["🧠", "Consultando memória"],
    memory_write: ["📝", "Registrando memória"],
    obsidian_sync: ["📝", "Atualizando Obsidian"],
    goal_create: ["🎯", "Criando objetivo"],
    goal_list: ["🎯", "Consultando objetivos"],
    agenda_create: ["📅", "Criando evento na agenda"],
    agenda_list: ["📅", "Consultando agenda"],
    whatsapp_send: ["💬", "Enviando WhatsApp"],
    whatsapp_status: ["💬", "Consultando WhatsApp"],
    image_generate: ["🖼", "Gerando imagem"],
    opencode_run: ["⚙", "Executando engenharia (OpenCode)"],
    graph_plan: ["⬡", "Planejando Graph"],
    graph_execute: ["⚙", "Executando Graph"],
    graph_status: ["⬡", "Consultando Graph"],
    graph_list: ["⬡", "Listando Graphs"],
    graph_recover: ["⬡", "Recuperando Graphs"],
  };
  function toolCard(toolId, phase, success) {
    const [ico, name] = TOOL_LABELS[toolId] || ["🔧", toolId];
    const div = document.createElement("div");
    const cls = phase === "start" ? "run" : success === false ? "err" : "ok";
    const state = phase === "start" ? "Executando…" : success === false ? "✗ Falhou" : "✓ Concluído";
    div.className = "tool-card " + cls;
    div.innerHTML = '<span class="t-ico">' + ico + '</span><span class="t-name">' + esc(name) + '</span><span class="t-detail"></span><span class="t-state">' + state + "</span>";
    $("#messages").appendChild(div);
    scrollBottom();
    return div;
  }

  // ── Graph card dentro do chat ──
  const NODE_ICON = { COMPLETED: ["✓", "st-done"], RUNNING: ["●", "st-run"], FAILED: ["✗", "st-fail"], BLOCKED: ["⊘", "st-fail"], REWORK: ["↻", "st-rework"], READY: ["○", "st-wait"], PENDING: ["○", "st-wait"], CANCELLED: ["—", "st-wait"] };

  function graphCard(runId, goal) {
    const card = document.createElement("div");
    card.className = "graph-card";
    card.id = "graph-card-" + runId.replace(/[^a-z0-9._-]/gi, "_");
    card.innerHTML =
      '<div class="graph-head" data-run="' + esc(runId) + '">' +
      '<span class="g-ico">⬡</span>' +
      '<span class="g-title">GRAPH — ' + esc(goal || runId) + "</span>" +
      '<span class="badge" data-role="status">…</span>' +
      "</div>" +
      '<div class="graph-body hidden"><div data-role="nodes"></div><div class="g-events" data-role="events"></div></div>';
    card.querySelector(".graph-head").addEventListener("click", () => {
      card.querySelector(".graph-body").classList.toggle("hidden");
      refreshGraphCard(runId);
    });
    $("#messages").appendChild(card);
    scrollBottom();
    refreshGraphCard(runId);
    startGraphPolling(runId);
    return card;
  }

  async function refreshGraphCard(runId) {
    const safe = runId.replace(/[^a-z0-9._-]/gi, "_");
    const card = document.getElementById("graph-card-" + safe);
    if (!card) return;
    try {
      const data = await api("/api/graphs/" + encodeURIComponent(runId));
      const badge = card.querySelector('[data-role="status"]');
      badge.textContent = data.run.status;
      badge.className = "badge" + (data.run.status === "COMPLETED" ? " ok" : data.run.status === "FAILED" || data.run.status === "BLOCKED" ? " bad" : "");
      const nodesBox = card.querySelector('[data-role="nodes"]');
      nodesBox.innerHTML = data.nodes.map((n) => {
        const [ic, cl] = NODE_ICON[n.status] || ["○", "st-wait"];
        const meta = [n.assignedAgent, n.retryCount ? "retry " + n.retryCount : "", n.error ? esc(n.error.slice(0, 90)) : ""].filter(Boolean).join(" · ");
        return '<div class="g-node"><span class="st ' + cl + '">' + ic + '</span><span class="nm">' + esc(n.title) + "</span><span class=\"mt\">" + esc(meta) + "</span></div>";
      }).join("");
      const evBox = card.querySelector('[data-role="events"]');
      const evs = (data.events || []).slice(-8);
      evBox.innerHTML = evs.length ? evs.map((e) => '<div class="g-event">' + esc(new Date(e.at).toLocaleTimeString("pt-BR")) + " · " + esc(e.event) + "</div>").join("") : "";
      const active = ["PLANNED", "RUNNING"].includes(data.run.status);
      $("#graph-badge").classList.toggle("hidden", !active);
      if (!active) stopGraphPolling(runId);
    } catch {}
  }

  function startGraphPolling(runId) {
    if (graphPollers.has(runId)) return;
    const t = setInterval(() => refreshGraphCard(runId), 2500);
    graphPollers.set(runId, t);
  }
  function stopGraphPolling(runId) {
    const t = graphPollers.get(runId);
    if (t) { clearInterval(t); graphPollers.delete(runId); }
  }

  // ── Approval ──
  function showApproval(toolId, input) {
    pendingApproval = { toolId, input };
    const card = document.createElement("div");
    card.className = "approval-card";
    card.innerHTML =
      '<div class="a-q">O agente quer executar: <strong>' + esc(toolId) + "</strong>. Autoriza?</div>" +
      '<div class="a-actions"><button class="btn-primary" data-act="yes">Sim, executar</button><button class="btn-secondary" data-act="no">Não</button></div>';
    card.querySelector('[data-act="yes"]').addEventListener("click", () => { card.remove(); resolveApproval(true); });
    card.querySelector('[data-act="no"]').addEventListener("click", () => { card.remove(); resolveApproval(false); });
    $("#messages").appendChild(card);
    scrollBottom();
  }

  async function resolveApproval(approved) {
    if (!pendingApproval) return;
    const approval = pendingApproval;
    pendingApproval = null;
    setTyping(true);
    try {
      const result = await api("/api/chat/session/" + encodeURIComponent(currentSession) + "/approve", {
        toolId: approval.toolId, input: approval.input, approved,
      });
      setTyping(false);
      handleResult(result);
    } catch (error) {
      setTyping(false);
      addAgentMarkdown("Erro ao processar aprovação: " + error.message);
    }
  }

  function handleResult(result) {
    if (!result) return;
    if (result.type === "answer" && result.message) {
      if ((result.toolResults || []).some((t) => t.toolId && t.toolId.startsWith("graph_"))) {
        showSessionGraphCards();
      }
      addAgentMarkdown(result.message.content);
    } else if (result.type === "approval_requested" && result.approval) {
      showApproval(result.approval.toolId, result.approval.input);
    } else if (result.type === "cancelled") {
      addAgentMarkdown("Ok, ação cancelada.");
    } else if (result.type === "error") {
      addAgentMarkdown(result.message ? result.message.content : "Ocorreu um erro.");
    }
  }

  // cria cards no chat para os Graphs desta sessão (dados reais via /api/graphs)
  async function showSessionGraphCards() {
    try {
      const { runs } = await api("/api/graphs?limit=20");
      runs.filter((r) => r.sessionKey === currentSession).forEach((r) => {
        const safe = r.id.replace(/[^a-z0-9._-]/gi, "_");
        if (!document.getElementById("graph-card-" + safe)) graphCard(r.id, r.goal);
      });
    } catch {}
  }

  function maybeShowGraphFromTool(t) {
    if (t && t.runId) graphCard(t.runId, t.goal);
  }

  // ── Typing ──
  function setTyping(on) { $("#typing").classList.toggle("hidden", !on); $("#input").disabled = on; $("#btn-send").disabled = on; }

  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 3500);
  }

  // ── Sessões ──
  async function loadSessions() {
    try {
      const { sessions } = await api("/api/chat/sessions");
      const list = $("#session-list");
      list.innerHTML = "";
      sessions.forEach((s) => {
        const div = document.createElement("div");
        div.className = "session-item" + (s.sessionKey === currentSession ? " active" : "");
        const title = s.topic || s.sessionKey;
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
        div.innerHTML =
          '<div class="s-label">' + esc(title) + '<span class="s-sub">' + esc(when) + (s.preview ? " · " + esc(s.preview.slice(0, 60)) : "") + "</span></div>" +
          '<span class="s-actions"><button title="Renomear" data-act="ren">✎</button><button title="Excluir" data-act="del">🗑</button></span>';
        div.addEventListener("click", (e) => { if (e.target.closest(".s-actions")) return; openSession(s.sessionKey); });
        div.querySelector('[data-act="ren"]').addEventListener("click", async (e) => {
          e.stopPropagation();
          const nt = prompt("Novo título da conversa:", title);
          if (nt && nt.trim()) { try { await api("/api/chat/session/" + encodeURIComponent(s.sessionKey), { title: nt.trim() }, "PATCH"); loadSessions(); if (s.sessionKey === currentSession) $("#chat-title").textContent = nt.trim(); } catch (err) { toast(err.message); } }
        });
        div.querySelector('[data-act="del"]').addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm("Excluir esta conversa?")) return;
          try { await api("/api/chat/session/" + encodeURIComponent(s.sessionKey), {}, "DELETE"); if (s.sessionKey === currentSession) newChat(); loadSessions(); } catch (err) { toast(err.message); }
        });
        list.appendChild(div);
      });
    } catch {}
  }

  async function newChat() {
    currentSession = "chat-" + Date.now().toString(36);
    try { await api("/api/chat/session", { key: currentSession }); } catch {}
    $("#chat-title").textContent = "Second Brain";
    $("#messages").innerHTML = "";
    addAgentMarkdown("Olá! Estou aqui. O que você quer fazer?");
    showView("chat");
    loadSessions();
  }

  async function openSession(key) {
    currentSession = key;
    $("#chat-title").textContent = key;
    showView("chat");
    try {
      const { messages } = await api("/api/chat/session/" + encodeURIComponent(key) + "/messages");
      const box = $("#messages");
      box.innerHTML = "";
      if (!messages.length) addAgentMarkdown("Olá! Estou aqui. O que você quer fazer?");
      messages.forEach((m) => {
        if (m.role === "user") addUserMessage(m.content);
        else if (m.role === "assistant") addAgentMarkdown(m.content);
      });
    } catch (error) {
      addAgentMarkdown("Não consegui carregar esta conversa: " + error.message);
    }
    loadSessions();
  }

  $("#btn-new-chat").addEventListener("click", newChat);

  // hints do hero
  document.querySelectorAll(".hint-chip").forEach((c) => {
    c.addEventListener("click", () => { $("#input").value = c.dataset.hint || c.textContent; send(); });
  });

  // ── Envio com streaming (SSE = eventos reais) ──
  async function send() {
    const input = $("#input");
    let text = input.value.trim();
    if (!text || input.disabled) return;
    if (attachedFile) {
      text += "\n[anexo local: " + attachedFile.name + "]";
      attachedFile = null;
      renderAttachPreview();
    }
    if (!currentSession) { currentSession = "chat-" + Date.now().toString(36); try { await api("/api/chat/session", { key: currentSession }); } catch {} }
    input.value = "";
    input.style.height = "auto";
    addUserMessage(text);
    setTyping(true);

    let statusEl = addStatusLine("Consultando o Second Brain…");
    const toolCards = new Map();
    let gotMessage = false;

    try {
      const url = API + "/api/chat/session/" + encodeURIComponent(currentSession) + "/stream?text=" + encodeURIComponent(text);
      const es = new EventSource(url);

      es.addEventListener("status", (e) => {
        const d = JSON.parse(e.data || "{}");
        if (statusEl) statusEl.remove();
        statusEl = addStatusLine(d.stage || "Processando…");
      });
      es.addEventListener("tool", (e) => {
        const d = JSON.parse(e.data || "{}");
        if (d.phase === "start") {
          toolCards.set(d.toolId, toolCard(d.toolId, "start"));
          if (statusEl) statusEl.remove();
          statusEl = addStatusLine(d.graph ? "Executando Graph…" : "Executando " + d.toolId + "…");
        } else {
          const c = toolCards.get(d.toolId);
          if (c) c.remove();
          toolCard(d.toolId, "done", d.success);
          if (d.graph && d.success) { /* o card do graph é criado quando o runId chega no resultado */ }
        }
      });
      es.addEventListener("message", (e) => {
        gotMessage = true;
        if (statusEl) { statusEl.remove(); statusEl = null; }
        const result = JSON.parse(e.data || "{}");
        extractGraphRuns(result);
        handleResult(result);
      });
      es.addEventListener("done", () => { es.close(); setTyping(false); loadSessions(); });
      es.addEventListener("error", async () => {
        es.close();
        if (gotMessage) { setTyping(false); return; }
        if (statusEl) { statusEl.remove(); statusEl = null; }
        // fallback: POST simples (mantém funcionamento se SSE indisponível)
        try {
          const result = await api("/api/chat/session/" + encodeURIComponent(currentSession) + "/message", { text });
          extractGraphRuns(result);
          handleResult(result);
        } catch (err) {
          addAgentMarkdown("Falha ao conectar com o agente: " + err.message);
        }
        setTyping(false);
        loadSessions();
      });
    } catch (error) {
      if (statusEl) statusEl.remove();
      setTyping(false);
      addAgentMarkdown("Falha ao conectar com o agente: " + error.message);
    }
  }

  // extrai runId de resultados graph_* para criar o card no chat
  function extractGraphRuns(result) {
    if (!result || !result.toolResults) return;
    // resultado completo do último tool fica no conteúdo quando graph_plan roda;
    // buscamos runId na resposta persistida via /api/graphs da sessão
  }

  $("#btn-send").addEventListener("click", send);
  const inputEl = $("#input");
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  });

  // anexar (preview local; o backend recebe o nome do anexo como texto)
  $("#btn-attach").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    attachedFile = { name: f.name };
    renderAttachPreview();
    e.target.value = "";
  });
  function renderAttachPreview() {
    let prev = $("#composer").querySelector(".attach-preview");
    if (prev) prev.remove();
    if (!attachedFile) return;
    prev = document.createElement("div");
    prev.className = "attach-preview";
    prev.innerHTML = "📎 " + esc(attachedFile.name) + ' <button class="composer-btn" title="Remover">✕</button>';
    prev.querySelector("button").addEventListener("click", () => { attachedFile = null; renderAttachPreview(); });
    $("#composer").prepend(prev);
  }

  // voz (Web Speech API quando disponível)
  let recognizing = false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $("#btn-voice").classList.add("hidden");
  $("#btn-voice").addEventListener("click", () => {
    if (!SR) return;
    if (recognizing) { return; }
    const rec = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = false;
    rec.onresult = (e) => { inputEl.value += (inputEl.value ? " " : "") + e.results[0][0].transcript; };
    rec.onend = () => { recognizing = false; $("#btn-voice").classList.remove("rec"); };
    rec.onerror = () => { recognizing = false; $("#btn-voice").classList.remove("rec"); };
    recognizing = true;
    $("#btn-voice").classList.add("rec");
    try { rec.start(); } catch { recognizing = false; }
  });

  // ── Graphs (view) ──
  async function loadGraphsPanel() {
    const list = $("#graphs-list");
    try {
      const { runs } = await api("/api/graphs?limit=30");
      if (!runs.length) { list.innerHTML = '<p class="muted">Nenhum Graph ainda. Peça algo multi-etapas no chat.</p>'; return; }
      list.innerHTML = "";
      runs.forEach((r) => {
        const div = document.createElement("div");
        div.className = "list-item";
        const done = r.nodes.filter((n) => n.status === "COMPLETED").length;
        const nodesHtml = r.nodes.map((n) => {
          const [ic, cl] = NODE_ICON[n.status] || ["○", "st-wait"];
          return '<span class="' + cl + '">' + ic + " " + esc(n.title) + "</span>";
        }).join(" &nbsp;·&nbsp; ");
        div.innerHTML =
          "<h3>⬡ " + esc(r.goal.slice(0, 80)) + ' <span class="badge' + (r.status === "COMPLETED" ? " ok" : r.status === "FAILED" || r.status === "BLOCKED" ? " bad" : "") + '">' + esc(r.status) + "</span></h3>" +
          '<p class="muted">' + esc(r.id) + " · " + done + "/" + r.nodes.length + " nós concluídos</p>" +
          "<p>" + nodesHtml + "</p>";
        list.appendChild(div);
      });
    } catch { list.innerHTML = '<p class="muted">Graphs indisponíveis.</p>'; }
  }

  // ── Imagens ──
  async function loadImages() {
    try {
      const { images } = await api("/api/images");
      const grid = $("#images-grid");
      if (!images.length) { grid.innerHTML = '<p class="muted">Nenhuma imagem gerada ainda. Peça no chat: "gere uma imagem de …".</p>'; return; }
      grid.innerHTML = "";
      images.forEach((row) => {
        let url = null;
        try {
          const p = JSON.parse(row.payload);
          url = p.url || (p.urls && p.urls[0]) || null;
        } catch {}
        const div = document.createElement("div");
        div.className = "grid-card";
        div.innerHTML = (url ? '<img src="' + esc(url) + '" style="width:100%;border-radius:8px" alt="imagem gerada"/>' : "") +
          "<p>" + esc(new Date(row.occurred_at).toLocaleString("pt-BR")) + "</p>";
        grid.appendChild(div);
      });
    } catch {}
  }

  // ── Agenda ──
  async function loadAgenda() {
    try {
      const { events } = await api("/api/agenda");
      const list = $("#agenda-list");
      if (!events.length) { list.innerHTML = '<p class="muted">Nenhum compromisso.</p>'; return; }
      list.innerHTML = "";
      events.forEach((e) => {
        const div = document.createElement("div");
        div.className = "list-item";
        div.innerHTML = "<h3>" + esc(e.title) + "</h3><p>" + new Date(e.startsAt).toLocaleString("pt-BR") + (e.description ? " · " + esc(e.description) : "") + "</p>";
        list.appendChild(div);
      });
    } catch {}
  }
  $("#agenda-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#agenda-title").value.trim();
    const when = $("#agenda-when").value;
    if (!title || !when) return;
    try {
      await api("/api/agenda", { title, startsAt: new Date(when).toISOString() });
      $("#agenda-title").value = ""; $("#agenda-when").value = "";
      loadAgenda();
      toast("Evento criado na agenda.");
    } catch (err) { toast(err.message); }
  });

  // ── Conexões (Evolution real + QR + toggle IA) ──
  async function loadConnections() {
    try {
      const data = await api("/api/connections");
      const w = data.whatsapp || {};
      const badge = $("#wa-badge");
      badge.textContent = w.state || "?";
      badge.className = "badge " + (w.available ? "ok" : "bad");
      $("#wa-detail").textContent = w.available
        ? "Instância conectada e disponível."
        : (w.error ? "Configuração: " + w.error : "Instância não conectada. Clique em Conectar para gerar o QR Code (Evolution).");
      $("#wa-ai-toggle").checked = w.aiEnabled !== false;
      if (!w.available) $("#wa-qr-wrap").classList.add("hidden");
    } catch {
      $("#wa-detail").textContent = "Backend indisponível.";
    }
  }
  $("#wa-connect").addEventListener("click", async () => {
    $("#wa-qr-status").textContent = "Solicitando QR Code à Evolution…";
    $("#wa-qr-wrap").classList.remove("hidden");
    $("#wa-qr").removeAttribute("src");
    try {
      const r = await api("/api/connections/whatsapp/connect", {}, "POST");
      if (r.state === "open") {
        $("#wa-qr-status").textContent = "Instância já está conectada.";
        loadConnections();
        return;
      }
      if (r.qrBase64) {
        $("#wa-qr").src = r.qrBase64.startsWith("data:") ? r.qrBase64 : "data:image/png;base64," + r.qrBase64;
        $("#wa-qr-status").textContent = "Escaneie com o WhatsApp e aguarde…";
        startWaPolling();
      } else {
        $("#wa-qr-status").textContent = r.error || "QR Code indisponível.";
      }
    } catch (err) {
      $("#wa-qr-status").textContent = "Erro: " + err.message;
    }
  });
  function startWaPolling() {
    if (waPollTimer) clearInterval(waPollTimer);
    waPollTimer = setInterval(async () => {
      try {
        const data = await api("/api/connections");
        if (data.whatsapp && data.whatsapp.available) {
          clearInterval(waPollTimer); waPollTimer = null;
          $("#wa-qr-status").textContent = "✓ Conectado!";
          loadConnections();
        }
      } catch {}
    }, 3000);
  }
  $("#wa-ai-toggle").addEventListener("change", async (e) => {
    try {
      await api("/api/connections/whatsapp/ai", { enabled: e.target.checked }, "POST");
      toast(e.target.checked ? "IA reativada no WhatsApp." : "IA desativada (WhatsApp continua conectado).");
    } catch (err) { toast(err.message); }
  });

  // ── Routing ──
  async function loadRouting() {
    try {
      const data = await api("/api/routing");
      const box = $("#routing-detail");
      const g = data.providers.groq;
      const o = data.providers.openrouter;
      box.innerHTML =
        '<div class="list-item"><h3>Groq <span class="badge ' + (g.configured ? "ok" : "bad") + '">' + (g.configured ? "● conectado" : "○ sem chave") + "</span></h3>" +
        "<p>Modelo: " + esc(g.model) + "</p>" +
        "<p>Chaves: " + (g.maskedKeys.length ? g.maskedKeys.map(esc).join(", ") : "nenhuma") + "</p></div>" +
        '<div class="list-item"><h3>OpenRouter <span class="badge ' + (o.configured ? "ok" : "bad") + '">' + (o.configured ? "● conectado" : "○ sem chave") + "</span></h3>" +
        "<p>Chave: " + (o.maskedKey ? esc(o.maskedKey) : "nenhuma") + "</p></div>" +
        '<div class="list-item"><p class="muted">' + esc(data.model.note) + "</p></div>";
    } catch { $("#routing-detail").innerHTML = '<p class="muted">Routing indisponível.</p>'; }
  }

  // ── Boot ──
  (async function boot() {
    await loadSessions();
    const first = document.querySelector(".session-item");
    if (first) first.click(); else addAgentMarkdown("Olá! Estou aqui. O que você quer fazer?");
  })();
})();
