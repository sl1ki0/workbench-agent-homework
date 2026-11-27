import { makeModel, readModelConfig } from '../model/index.js';
import type { Message, Model, ModelProgress, ToolDefinition } from '../types.js';

export class ModelControl implements Model {
  private effort?: string;
  private client?: ReturnType<typeof makeModel>;
  observe?: (progress: ModelProgress) => void;

  private environment(): NodeJS.ProcessEnv {
    return this.effort ? { ...process.env, OPENAI_REASONING_EFFORT: this.effort } : process.env;
  }

  settings() {
    return readModelConfig(this.environment());
  }

  setThinking(level: string) {
    if (!['off', 'low', 'medium', 'high', 'default'].includes(level)) {
      throw new Error('/thinking off|low|medium|high|default');
    }
    this.effort = level === 'default' ? undefined : level === 'off' ? 'none' : level;
    this.client = undefined;
  }

  complete(messages: Message[], tools: ToolDefinition[]) {
    this.client ??= makeModel(this.environment());
    return this.client.complete(messages, tools, this.observe);
  }
}
