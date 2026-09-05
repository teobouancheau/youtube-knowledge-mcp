/**
 * Reading configuration from the environment without trusting it.
 *
 * A bare `Number()` of an environment value turns a typo into `NaN`, and `NaN` compares
 * false with everything: a concurrency limit of `NaN` queued every yt-dlp call
 * forever, and a cache TTL of `NaN` never expired anything. Every numeric or
 * enumerated setting therefore comes through here, where an unusable value
 * falls back to the default and says so once on stderr.
 */

export interface IntBounds {
  min?: number;
  max?: number;
}

function warn(name: string, reason: string): void {
  console.error(`Ignoring ${name}: ${reason}.`);
}

export function envString(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function envInt(
  name: string,
  fallback: number,
  bounds: IntBounds = {},
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = envString(name, env);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    warn(name, `"${raw}" is not a whole number, using ${fallback}`);
    return fallback;
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    warn(name, `${parsed} is below the minimum of ${bounds.min}, using ${fallback}`);
    return fallback;
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    warn(name, `${parsed} is above the maximum of ${bounds.max}, using ${fallback}`);
    return fallback;
  }
  return parsed;
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

export function envBool(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = envString(name, env)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (TRUE_WORDS.has(raw)) return true;
  if (FALSE_WORDS.has(raw)) return false;
  warn(name, `"${raw}" is not a boolean, using ${String(fallback)}`);
  return fallback;
}

export function envList(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * One of a closed set of values, or `undefined` when unset.
 *
 * Unlike the helpers above this throws on an unknown value: a browser name or
 * proxy scheme that is misspelt is a configuration mistake the operator wants
 * to hear about at boot, not a setting to quietly ignore.
 */
export function envEnum<T extends string>(
  name: string,
  values: readonly T[],
  env: NodeJS.ProcessEnv = process.env
): T | undefined {
  const raw = envString(name, env);
  if (raw === undefined) return undefined;

  const match = values.find((value) => value === raw.toLowerCase());
  if (match === undefined) {
    throw new Error(`${name} must be one of ${values.join(', ')}; got "${raw}".`);
  }
  return match;
}
