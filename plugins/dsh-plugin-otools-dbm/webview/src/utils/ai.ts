import { invoke } from '@tauri-apps/api/core';

export type AiChatRole = 'user' | 'assistant';

export interface AiChatMessage {
  id: string;
  role: AiChatRole;
  content: string;
  createdAt: string;
}

export interface OtoolsAiGenerateTextRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

const buildMessageId = () =>
  `${Date.now()}_${Math.random().toString(16).slice(2)}`;

export const createAiChatMessage = (
  role: AiChatRole,
  content: string,
  createdAt = new Date().toISOString()
): AiChatMessage => ({
  id: buildMessageId(),
  role,
  content: content.trim(),
  createdAt,
});

export const normalizeAiChatMessages = (value: unknown): AiChatMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = (item || {}) as Record<string, unknown>;
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      if (!content) {
        return null;
      }

      return {
        id: typeof record.id === 'string' && record.id.trim() ? record.id : buildMessageId(),
        role: record.role === 'user' ? 'user' : 'assistant',
        content,
        createdAt:
          typeof record.createdAt === 'string' && record.createdAt.trim()
            ? record.createdAt
            : new Date().toISOString(),
      } satisfies AiChatMessage;
    })
    .filter((item): item is AiChatMessage => !!item);
};

export class OtoolsAiApi {
  static async generateText(request: OtoolsAiGenerateTextRequest): Promise<string> {
    return invoke<string>('otools_ai_generate_text', { request });
  }

  static async loadChatHistory(prefix: string): Promise<AiChatMessage[]> {
    const messages = await invoke<AiChatMessage[]>('otools_ai_load_chat_history', { prefix });
    return normalizeAiChatMessages(messages);
  }

  static async saveChatHistory(prefix: string, messages: AiChatMessage[]): Promise<void> {
    await invoke('otools_ai_save_chat_history', {
      prefix,
      messages: normalizeAiChatMessages(messages),
    });
  }
}
