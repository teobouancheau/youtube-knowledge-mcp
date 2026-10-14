import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { probeImage } from '../src/utils/image-dimensions.js';

/**
 * The plugin folder is what Anthropic's directory validates and what users install.
 * It launches this package through npx, and the directory refuses a launcher that is
 * not pinned to an exact version, so the pin is written down in `plugin/.mcp.json`.
 * Nothing else ties that pin to a release: a version bump that forgot it would ship a
 * plugin that installs the previous version. These checks fail by name instead.
 */

const ROOT = new URL('../', import.meta.url);
const PLUGIN = new URL('plugin/', ROOT);

const httpsUrl = z.string().url().startsWith('https://');

const packageSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

const pluginSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().min(1),
  license: z.string().min(1),
  icon: z.string().min(1),
  homepage: httpsUrl,
  documentationUrl: httpsUrl,
  supportUrl: httpsUrl,
  privacyPolicyUrl: httpsUrl,
});

const mcpSchema = z.object({
  mcpServers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()) })),
});

async function readJson<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
  const text = await readFile(url, 'utf-8');
  return schema.parse(JSON.parse(text));
}

async function load(): Promise<{
  pkg: z.infer<typeof packageSchema>;
  plugin: z.infer<typeof pluginSchema>;
  mcp: z.infer<typeof mcpSchema>;
}> {
  const [pkg, plugin, mcp] = await Promise.all([
    readJson(new URL('package.json', ROOT), packageSchema),
    readJson(new URL('.claude-plugin/plugin.json', PLUGIN), pluginSchema),
    readJson(new URL('.mcp.json', PLUGIN), mcpSchema),
  ]);
  return { pkg, plugin, mcp };
}

describe('plugin bundle', () => {
  it('is released with the package', async () => {
    const { pkg, plugin } = await load();
    expect(plugin.version).toBe(pkg.version);
  });

  it('launches exactly this package at exactly this version', async () => {
    const { pkg, mcp } = await load();
    const servers = Object.values(mcp.mcpServers);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({ command: 'npx', args: ['-y', `${pkg.name}@${pkg.version}`] });
  });

  it('has a name the directory accepts', async () => {
    const { plugin } = await load();
    expect(plugin.name).toMatch(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(plugin.name).not.toMatch(/^(claude|anthropic|official|plugin|mcp|test)$/);
  });

  it('links a privacy policy that covers what the directory requires', async () => {
    const { plugin } = await load();
    expect(new URL(plugin.privacyPolicyUrl).pathname.endsWith('/PRIVACY.md')).toBe(true);

    const policy = await readFile(new URL('PRIVACY.md', ROOT), 'utf-8');
    for (const heading of [
      'Data collection',
      'Third party sharing',
      'Storage and retention',
      'Contact',
    ]) {
      expect(policy, `PRIVACY.md is missing "${heading}"`).toContain(`## ${heading}`);
    }
  });

  it('ships a 512 by 512 PNG icon', async () => {
    const { plugin } = await load();
    const bytes = await readFile(new URL(plugin.icon, PLUGIN));
    expect(probeImage(new Uint8Array(bytes))).toMatchObject({
      format: 'png',
      width: 512,
      height: 512,
    });
  });

  it('has a README of at least 40 words outside code blocks', async () => {
    const readme = await readFile(new URL('README.md', PLUGIN), 'utf-8');
    const prose = readme.replace(/```[\s\S]*?```/g, '');
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  });

  it('keeps files the directory refuses out of the plugin folder', async () => {
    const files = await readdir(PLUGIN, { recursive: true });
    const refused = files.filter((file) =>
      /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.npmrc|package\.json|package-lock\.json)$/.test(
        file
      )
    );
    expect(refused).toEqual([]);
  });
});
