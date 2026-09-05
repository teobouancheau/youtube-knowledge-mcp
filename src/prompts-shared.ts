import { z } from 'zod';

/** The two things every prompt needs. */

export function userMessage(text: string): {
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
} {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export const video = z.string().describe('YouTube video ID or URL');
