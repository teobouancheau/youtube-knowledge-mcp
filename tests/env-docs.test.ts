import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Every setting the code reads must be documented in the README's environment
 * table and listed in .env.example. The names are collected from the source,
 * so a setting added in code without documentation fails here by name.
 */

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (path.endsWith('.ts')) files.push(path);
  }
  return files;
}

async function settingsInSource(): Promise<string[]> {
  const root = new URL('../src', import.meta.url).pathname;
  const names = new Set<string>(['MCP_MODE']);
  for (const file of await sourceFiles(root)) {
    const text = await readFile(file, 'utf-8');
    for (const match of text.matchAll(/env(?:Int|Bool|List|Enum|String)\(\s*'([A-Z0-9_]+)'/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
    for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('environment variables are documented', () => {
  it('names every setting the code reads in the README table and in .env.example', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf-8');
    const example = await readFile(new URL('../.env.example', import.meta.url), 'utf-8');
    const settings = await settingsInSource();

    expect(settings.length).toBeGreaterThan(15);
    for (const name of settings) {
      expect(readme, `README env table lacks ${name}`).toMatch(new RegExp(`\\| \`${name}\``));
      expect(example, `.env.example lacks ${name}`).toContain(`${name}=`);
    }
  });
});
