import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { probeImage } from '../src/utils/image-dimensions.js';

/**
 * The plugin folder is what Anthropic's directory validates and what users install.
 * Claude Code installs the packages that `plugin/package-lock.json` pins, with their
 * hashes, and the server runs from them with `node`. The pin to this package is written in
 * `plugin/package.json` and again in the lockfile, and the plugin's own version is a third
 * copy. Nothing else ties them together: a release that moved one would ship a plugin that
 * installs the previous version. These checks fail by name instead.
 */

const ROOT = new URL('../', import.meta.url);
const PLUGIN = new URL('plugin/', ROOT);

const httpsUrl = z.string().url().startsWith('https://');

const PLUGIN_ROOT_VARIABLE = '$' + '{CLAUDE_PLUGIN_ROOT}';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const REGISTRY = 'https://registry.npmjs.org/';

const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  bin: z.record(z.string(), z.string()),
});

const pluginPackageSchema = z.object({
  version: z.string().min(1),
  private: z.literal(true),
  dependencies: z.record(z.string(), z.string()),
});

const lockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
      hasInstallScript: z.boolean().optional(),
      link: z.boolean().optional(),
      dependencies: z.record(z.string(), z.string()).optional(),
    })
  ),
});

/** Negative when `a` is the older version, zero when equal, positive when newer. */
function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number));
  const difference = left?.findIndex((part, index) => part !== right?.[index]) ?? -1;
  return difference === -1 ? 0 : (left?.[difference] ?? 0) - (right?.[difference] ?? 0);
}

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
  pluginPackage: z.infer<typeof pluginPackageSchema>;
  lock: z.infer<typeof lockSchema>;
}> {
  const [pkg, plugin, mcp, pluginPackage, lock] = await Promise.all([
    readJson(new URL('package.json', ROOT), packageSchema),
    readJson(new URL('.claude-plugin/plugin.json', PLUGIN), pluginSchema),
    readJson(new URL('.mcp.json', PLUGIN), mcpSchema),
    readJson(new URL('package.json', PLUGIN), pluginPackageSchema),
    readJson(new URL('package-lock.json', PLUGIN), lockSchema),
  ]);
  return { pkg, plugin, mcp, pluginPackage, lock };
}

describe('plugin bundle', () => {
  it('is never ahead of the package it installs', async () => {
    const { pkg, plugin } = await load();
    // The plugin is pointed at a release once that release is on npm, so it may trail the
    // package for the length of one release, and may never lead it.
    expect(compareVersions(plugin.version, pkg.version)).toBeLessThanOrEqual(0);
  });

  it('is one version in the manifest, the plugin package and the dependency it pins', async () => {
    const { pkg, plugin, pluginPackage } = await load();
    expect(plugin.version).toMatch(EXACT_VERSION);
    expect(pluginPackage.version).toBe(plugin.version);
    expect(pluginPackage.dependencies).toEqual({ [pkg.name]: plugin.version });
  });

  it('locks that version, every package with a hash, from the npm registry over https', async () => {
    const { pkg, plugin, pluginPackage, lock } = await load();
    const { '': root, ...installed } = lock.packages;

    expect(root?.dependencies).toEqual(pluginPackage.dependencies);
    expect(installed[`node_modules/${pkg.name}`]?.version).toBe(plugin.version);

    const entries = Object.entries(installed);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter(([, entry]) => !entry.integrity?.startsWith('sha512-'))).toEqual([]);
    expect(entries.filter(([, entry]) => !entry.resolved?.startsWith(REGISTRY))).toEqual([]);
    // Claude Code runs no install script, so a package that needs one would be half installed.
    expect(entries.filter(([, entry]) => entry.hasInstallScript === true)).toEqual([]);
    expect(entries.filter(([, entry]) => entry.link === true)).toEqual([]);
  });

  it('runs the locked package with node, from the plugin and not through a launcher', async () => {
    const { pkg, mcp } = await load();
    const binary = pkg.bin[pkg.name];
    const servers = Object.values(mcp.mcpServers);

    expect(binary).toBeDefined();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      command: 'node',
      args: [`${PLUGIN_ROOT_VARIABLE}/node_modules/${pkg.name}/${binary ?? ''}`],
    });
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
      /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.npmrc|bunfig\.toml|uv\.toml)$/.test(file)
    );
    expect(refused).toEqual([]);
  });
});
