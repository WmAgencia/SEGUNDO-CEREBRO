import { create } from "zustand";
import type { ChatMessage, EdlPatch } from "../../api/types";

export interface ChatState {
  messages: ChatMessage[];
  connected: boolean;
  thinking: boolean;
  autonomousMode: boolean;

  setMessages: (m: ChatMessage[]) => void;
  push: (m: ChatMessage) => void;
  setConnected: (c: boolean) => void;
  setThinking: (t: boolean) => void;
  setAutonomous: (a: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  connected: false,
  thinking: false,
  autonomousMode: false,

  setMessages: (messages) => set({ messages }),
  push: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setConnected: (connected) => set({ connected }),
  setThinking: (thinking) => set({ thinking }),
  setAutonomous: (autonomousMode) => set({ autonomousMode }),
}));

export function makeMessage(role: ChatMessage["role"], content: string, patches?: EdlPatch[]): ChatMessage {
  return { id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, role, content, ts: Date.now(), patches };
}
