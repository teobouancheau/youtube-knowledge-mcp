import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../../src/utils/json-file.js';

/**
 * Against a real filesystem, because the property worth proving — that a failed
 * write leaves the previous document intact — is precisely what a mocked `fs`
 * assumes away.
 */

let directory: string;
let file: string;

const schema = z.object({ name: z.string(), count: z.number() });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'json-file-'));
  file = join(directory, 'document.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('writes a document that reads back through its schema', async () => {
    await writeJsonAtomic(file, { name: 'brain', count: 3 });

    expect(await readJsonFile(file, schema)).toEqual({ name: 'brain', count: 3 });
  });

  it('leaves no temporary file behind', async () => {
    await writeJsonAtomic(file, { name: 'brain', count: 3 });

    expect(await readdir(directory)).toEqual(['document.json']);
  });

  it('leaves the previous document intact when the write fails', async () => {
    await writeJsonAtomic(file, { name: 'first', count: 1 });

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(writeJsonAtomic(file, circular)).rejects.toThrow();
    expect(await readJsonFile(file, schema)).toEqual({ name: 'first', count: 1 });
  });

  it('cleans up after a write that could not start', async () => {
    const unreachable = join(directory, 'no-such-directory', 'document.json');

    await expect(writeJsonAtomic(unreachable, { name: 'brain', count: 1 })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('omits indentation when asked, for documents nobody reads', async () => {
    await writeJsonAtomic(file, { name: 'brain', count: 3 }, { pretty: false });

    expect(await readFile(file, 'utf-8')).toBe('{"name":"brain","count":3}');
  });
});

describe('readJsonFile', () => {
  it('returns undefined when the file does not exist', async () => {
    expect(await readJsonFile(join(directory, 'absent.json'), schema)).toBeUndefined();
  });

  it('returns undefined when the file is not JSON', async () => {
    await writeFile(file, 'half a wri', 'utf-8');

    expect(await readJsonFile(file, schema)).toBeUndefined();
  });

  it('returns undefined when the document does not match the schema', async () => {
    await writeJsonAtomic(file, { name: 'brain', count: 'three' });

    expect(await readJsonFile(file, schema)).toBeUndefined();
  });
});
