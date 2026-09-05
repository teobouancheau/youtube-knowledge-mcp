import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { removeHome, startStdioServer, type ServerHandle } from './harness.js';
import { CHANNEL, VIDEO } from './fixtures.js';

let server: ServerHandle;

beforeAll(async () => {
  server = await startStdioServer();
});

afterAll(async () => {
  await server.close();
  await removeHome(server.home);
});

const TOOL_VERBS =
  /^(get|fetch|search|list|save|build|ask|extract|export|download|digest|check|delete|update|rebuild)_/;

describe('prompts', () => {
  it('every prompt renders, and names only tools that exist', async () => {
    const tools = new Set((await server.client.listTools()).tools.map((t) => t.name));
    const prompts = (await server.client.listPrompts()).prompts;
    expect(prompts.length).toBeGreaterThanOrEqual(10);

    const sample: Record<string, string> = {
      video: VIDEO.id,
      videos: `${VIDEO.id},${VIDEO.id}`,
      channel: CHANNEL.handle,
      topic: 'search',
      quote: 'search',
      tag: 'systems',
      question: 'what',
      creator: CHANNEL.handle,
    };

    for (const prompt of prompts) {
      const args: Record<string, string> = {};
      for (const argument of prompt.arguments ?? []) {
        if (argument.required) args[argument.name] = sample[argument.name] ?? 'x';
      }
      const rendered = await server.client.getPrompt({ name: prompt.name, arguments: args });
      const text = rendered.messages
        .map((m) => (m.content.type === 'text' ? m.content.text : ''))
        .join('\n');
      expect(text.length, prompt.name).toBeGreaterThan(20);
      const named = Array.from(text.matchAll(/\b([a-z]+_[a-z_]+)\b/g), (match) => match[1] ?? '');
      const unknown = named.filter((name) => TOOL_VERBS.test(name) && !tools.has(name));
      expect(unknown, `${prompt.name} names tools that do not exist`).toEqual([]);
    }
  });
});
