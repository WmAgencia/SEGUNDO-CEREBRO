import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../state/editorStore";
import { useChatStore, makeMessage } from "../state/aiStore";
import { api } from "../../api/client";
import type { EdlPatch } from "../../api/types";
import styles from "./AIPanel.module.css";

export default function AIPanel() {
  const { projectId, toEDL, applyPatches, ranges } = useEditorStore();
  const {
    messages, connected, thinking, autonomousMode,
    setMessages, push, setConnected, setThinking, setAutonomous,
  } = useChatStore();

  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Carrega histórico e abre WS
  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then((p: any) => {
      if (p.chatHistory) setMessages(p.chatHistory);
    }).catch(() => {});
    const ws = api.chat(projectId);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "thinking") {
        setThinking(true);
      } else if (msg.type === "assistant_msg") {
        setThinking(false);
        push(makeMessage("assistant", msg.content, msg.patches));
        if (msg.patches && msg.patches.length) {
          applyPatches(msg.patches);
        }
      } else if (msg.type === "autonomous_requested") {
        // Modo autônomo: chama novamente com autonomous=true
        setAutonomous(true);
        runAutonomous();
      } else if (msg.type === "error") {
        setThinking(false);
        push(makeMessage("system", "⚠️ Erro: " + msg.error));
      }
    };
    return () => {
      ws.close();
    };
  }, [projectId]);

  // Auto-scroll do chat
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const send = () => {
    if (!text.trim() || !wsRef.current) return;
    const userMsg = makeMessage("user", text);
    push(userMsg);
    wsRef.current.send(JSON.stringify({
      type: "user_msg",
      projectId,
      text,
      edl: toEDL(),
    }));
    setText("");
  };

  const runAutonomous = () => {
    if (!wsRef.current) return;
    push(makeMessage("system", "▶ IA assumiu o controle…"));
    wsRef.current.send(JSON.stringify({
      type: "user_msg",
      projectId,
      text: "Edição autônoma: aplique melhorias gerais (cortes de silêncios, color, fades) e depois renderize.",
      edl: toEDL(),
      autonomous: true,
    }));
  };

  const startVoice = () => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Web Speech API não suportada neste navegador");
      return;
    }
    const r = new SR();
    r.lang = "pt-BR";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setText((prev) => (prev + " " + transcript).trim());
      setRecording(false);
    };
    r.onend = () => setRecording(false);
    r.onerror = () => setRecording(false);
    recognitionRef.current = r;
    r.start();
    setRecording(true);
  };
  const stopVoice = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
    setRecording(false);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          {autonomousMode ? "🤖 IA AUTÔNOMA" : "CHAT IA"}
        </span>
        <span className={`${styles.status} ${connected ? styles.online : styles.offline}`}>
          <span className={styles.dot} />
          {connected ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <div className={styles.list} ref={listRef}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            <div className={styles.greet}>
              <span className={styles.greetPrompt}>$</span>
              <span className={styles.greetText}>clipcon&gt;</span>
              <span className="terminal-cursor" />
            </div>
            <p className={styles.hint}>
              Peça mudanças em linguagem natural ou clique em <b>🎙️</b> para falar.
            </p>
            <div className={styles.suggestions}>
              {[
                "Remove os silêncios maiores que 1s",
                "Adiciona fade in/out nos cortes",
                "Aplica color grade cinematográfico",
                "Corta os 'é' e 'ah'",
                "Deixa mais dinâmico",
              ].map((s) => (
                <button key={s} className={styles.suggestion} onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`${styles.msg} ${styles[m.role]}`}>
            <div className={styles.role}>{m.role.toUpperCase()}</div>
            <div className={styles.content}>{m.content}</div>
            {m.patches && m.patches.length > 0 && (
              <div className={styles.patches}>
                {m.patches.map((p, i) => (
                  <span key={i} className={styles.patchTag}>{p.op}</span>
                ))}
                <span className={styles.patchesLabel}>aplicado</span>
              </div>
            )}
          </div>
        ))}
        {thinking && (
          <div className={`${styles.msg} ${styles.assistant} ${styles.thinking}`}>
            <div className={styles.role}>ASSISTANT</div>
            <div className={styles.content}>
              <span className={styles.dots}>
                <span /><span /><span />
              </span>
              pensando…
            </div>
          </div>
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          rows={1}
          placeholder="Peça uma mudança… ex: 'corta os silêncios e aplica color'"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className={`${styles.micBtn} ${recording ? styles.recording : ""}`}
          onClick={recording ? stopVoice : startVoice}
          title="Falar (Web Speech)"
        >
          {recording ? "⏹" : "🎙"}
        </button>
        <button className="primary" onClick={send} disabled={!text.trim()}>
          Enviar ⏎
        </button>
      </div>

      <div className={styles.actions}>
        <button onClick={runAutonomous} className={styles.autonomousBtn} disabled={!ranges.length}>
          <span className={styles.icon}>✨</span>
          <span>Editar com IA</span>
          <span className={styles.sub}>ela decide tudo</span>
        </button>
      </div>
    </div>
  );
}
