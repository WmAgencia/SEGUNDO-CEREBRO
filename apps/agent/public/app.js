(function () {
  "use strict";

  const API = (window.SECOND_BRAIN_API ? window.SECOND_BRAIN_API.replace(/\/$/, "") : "");
  let currentSession = "chat-default";
  let pendingApproval = null;

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, body) {
    const res = await fetch(API + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Views ──
  function showView(name) {
    ["chat", "images", "agenda", "connections", "routing"].forEach((v) => $("#view-" + v).classList.toggle("hidden", v !== name));
  }
  document.querySelectorAll(".sb-item").forEach((item) => {
    item.addEventListener("click", () => {
      const view = item.dataset.view;
      if (view === "commands") { newChat(); showView("chat"); return; }
      showView(view);
      if (view === "images") loadImages();
      if (view === "agenda") loadAgenda();
      if (view === "connections") loadConnections();
      if (view === "routing") loadRouting();
    });
  });

  // ── Sessions ──
  async function loadSessions() {
    try {
      const { sessions } = await api("/api/chat/sessions");
      const list = $("#session-list");
      list.innerHTML = "";
      sessions.forEach((s) => {
        const div = document.createElement("div");
        div.className = "session-item" + (s.sessionKey === currentSession ? " active" : "");
        div.textContent = s.topic || s.sessionKey;
        div.title = s.sessionKey;
        div.addEventListener("click", () => openSession(s.sessionKey));
        list.appendChild(div);
      });
    } catch { /* backend off */ }
  }

  async function newChat() {
    currentSession = "chat-" + Date.now().toString(36);
    try { await api("/api/chat/session", { key: currentSession }); } catch {}
    $("#chat-title").textContent = "Second Brain";
    $("#messages").innerHTML = "";
    addAgentMessage("Olá. Como posso ajudar?");
    $("#input").value = "";
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
      if (!messages.length) addAgentMessage("Olá. Como posso ajudar?");
      messages.forEach((m) => {
        if (m.role === "user") addUserMessage(m.content);
        else if (m.role === "assistant") addAgentMessage(m.content);
      });
    } catch (error) {
      setTyping(false);
      addAgentMessage("Não consegui carregar esta conversa: " + error.message);
    }
    loadSessions();
  }

  function addUserMessage(text) {
    const box = $("#messages");
    const div = document.createElement("div");
    div.className = "msg user";
    div.innerHTML = '<div class="avatar">V</div><div class="bubble"><p>' + esc(text).replace(/\n/g, "<br/>") + "</p></div>";
    box.appendChild(div);
    scrollToBottom();
  }

  function addAgentMessage(text, toolNote) {
    const box = $("#messages");
    const div = document.createElement("div");
    div.className = "msg agent";
    let note = "";
    if (toolNote) note = '<div class="tool-note ' + (toolNote.ok ? "ok" : "err") + '">' + esc(toolNote.text) + "</div>";
    div.innerHTML = '<div class="avatar">SB</div><div class="bubble"><p>' + esc(text).replace(/\n/g, "<br/>") + "</p>" + note + "</div>";
    box.appendChild(div);
    scrollToBottom();
  }

  function sysLine(text) {
    const div = document.createElement("div");
    div.className = "sys-msg";
    div.textContent = text;
    $("#messages").appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    const box = $("#messages");
    box.scrollTop = box.scrollHeight;
  }

  // ── Typing ──
  function setTyping(on) {
    $("#typing").classList.toggle("hidden", !on);
    $("#input").disabled = on;
    $("#btn-send").disabled = on;
  }

  // ── Send ──
  async function send() {
    const input = $("#input");
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = "";
    input.style.height = "auto";
    addUserMessage(text);
    setTyping(true);
    try {
      const result = await api("/api/chat/session/" + encodeURIComponent(currentSession) + "/message", { text });
      setTyping(false);
      if (result.type === "answer" && result.message) {
        showToolNote(result.toolResults);
        addAgentMessage(result.message.content);
      } else if (result.type === "approval_requested" && result.approval) {
        pendingApproval = result.approval;
        const tool = result.approval.toolId;
        sysLine("O agente quer executar: " + tool);
        addAgentMessage("Posso executar " + tool + "? (resposta: 'sim' para aprovar ou 'não' para cancelar)");
      } else if (result.type === "error") {
        addAgentMessage(result.message?.content || "Ocorreu um erro.");
      }
    } catch (error) {
      setTyping(false);
      addAgentMessage("Falha ao conectar com o agente: " + error.message + (API ? "" : " (API não configurada)"));
    }
    loadSessions();
  }

  function showToolNote(toolResults) {
    if (!toolResults) return;
    const last = toolResults[toolResults.length - 1];
    if (!last) return;
    const ok = last.success !== false;
    const text = ok ? "Ferramenta: " + last.toolId + " ✓" : "Ferramenta: " + last.toolId + " — " + (last.error || "falhou");
    const div = document.createElement("div");
    div.className = "tool-note " + (ok ? "ok" : "err");
    div.textContent = text;
    $("#messages").appendChild(div);
    scrollToBottom();
  }

  // ── Approval handling ──
  async function resolveApproval(approved) {
    if (!pendingApproval) return;
    const approval = pendingApproval;
    pendingApproval = null;
    setTyping(true);
    try {
      const result = await api("/api/chat/session/" + encodeURIComponent(currentSession) + "/approve", {
        toolId: approval.toolId,
        input: approval.input,
        approved,
      });
      setTyping(false);
      if (result.type === "answer" && result.message) {
        showToolNote(result.toolResults);
        addAgentMessage(result.message.content);
      } else if (result.type === "cancelled") {
        addAgentMessage("Ok, ação cancelada.");
      } else {
        addAgentMessage("Concluído.");
      }
    } catch (error) {
      setTyping(false);
      addAgentMessage("Erro ao processar aprovação: " + error.message);
    }
  }

  // ── Sidebar panels ──
  async function loadImages() {
    try {
      const { images } = await api("/api/images");
      const grid = $("#images-grid");
      if (!images.length) { grid.innerHTML = '<p class="muted">Nenhuma imagem gerada ainda.</p>'; return; }
      grid.innerHTML = "";
      images.forEach((row) => {
        const div = document.createElement("div");
        div.className = "grid-card";
        div.innerHTML = "<p>" + esc(new Date(row.occurred_at).toLocaleString()) + "</p>";
        grid.appendChild(div);
      });
    } catch { /* backend off */ }
  }

  async function loadAgenda() {
    try {
      const { events } = await api("/api/agenda");
      const list = $("#agenda-list");
      if (!events.length) { list.innerHTML = '<p class="muted">Nenhum compromisso.</p>'; return; }
      list.innerHTML = "";
      events.forEach((e) => {
        const div = document.createElement("div");
        div.className = "list-item";
        div.innerHTML = "<h3>" + esc(e.title) + "</h3><p>" + new Date(e.startsAt).toLocaleString("pt-BR") + (e.description ? " — " + esc(e.description) : "") + "</p>";
        list.appendChild(div);
      });
    } catch { /* backend off */ }
  }

  async function loadConnections() {
    try {
      const data = await api("/api/connections");
      const badge = $("#wa-badge");
      const detail = $("#wa-detail");
      const state = data.whatsapp.state;
      badge.textContent = state;
      badge.className = "badge " + (data.whatsapp.available ? "ok" : "bad");
      detail.textContent = data.whatsapp.available
        ? "Instância conectada e disponível."
        : (data.whatsapp.error ? "Configuração: " + data.whatsapp.error : "Instância não conectada. Configure EVOLUTION_API_URL/KEY no backend.");
    } catch { /* backend off */ }
  }

  async function loadRouting() {
    try {
      const data = await api("/api/routing");
      const box = $("#routing-detail");
      box.innerHTML = "";
      Object.entries(data.providers).forEach(([name, info]) => {
        const div = document.createElement("div");
        div.className = "list-item";
        const on = info.configured ? "✅ configurado" : "❌ não configurado";
        div.innerHTML = "<h3>" + esc(name) + "</h3><p>" + on + "</p>";
        box.appendChild(div);
      });
      const note = document.createElement("p");
      note.className = "muted";
      note.style.marginTop = "14px";
      note.textContent = data.model.note;
      box.appendChild(note);
    } catch { /* backend off */ }
  }

  // ── Composer events ──
  const inputEl = $("#input");
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  });
  $("#btn-send").addEventListener("click", send);
  $("#btn-new").addEventListener("click", newChat);
  $("#btn-collapse").addEventListener("click", () => {
    $("#sidebar").classList.toggle("collapsed");
  });

  // Inline approval via chat text: "sim"/"não" after a pending approval
  setInterval(() => {
    if (pendingApproval) {
      const raw = (inputEl.value || "").trim().toLowerCase();
      if (/^(sim|pode|ok|yes)/i.test(raw)) { inputEl.value = ""; resolveApproval(true); }
      else if (/^(não|nao|nao manda|cancela)/i.test(raw)) { inputEl.value = ""; resolveApproval(false); }
    }
  }, 300);

  // ── Init ──
  loadSessions();
})();