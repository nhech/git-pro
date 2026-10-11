import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

/**
 * Loads a compiled module in a VM with a stand-in `vscode`. Local modules that import `vscode` themselves are loaded the same way and share the stand-in;
 * everything else comes from Node. Not a test file: the unit glob only runs *.test.js.
 */
export function loadWithVscode(file: string, vscode: unknown, cache = new Map<string, Record<string, unknown>>()): Record<string, unknown> {
  const cached = cache.get(file); if (cached) return cached;
  const exports: Record<string, unknown> = {}, module = { exports }, load = createRequire(file);
  cache.set(file, exports);
  const require = (name: string): unknown => {
    if (name === 'vscode') return vscode;
    if (name.startsWith('.')) { const target = load.resolve(name); if (readFileSync(target, 'utf8').includes('require("vscode")')) return loadWithVscode(target, vscode, cache); }
    return load(name);
  };
  runInNewContext(readFileSync(file, 'utf8'), { exports, module, require, process, AbortController, TextDecoder, Buffer, setTimeout, clearTimeout, console }, { filename: file });
  return module.exports;
}
