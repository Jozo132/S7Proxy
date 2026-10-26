// @ts-check
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

describe('standalone package boundaries', () => {
  it('resolves source imports only within the package or declared external dependencies', () => {
    const root = new URL('../../', import.meta.url);
    const metadata = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    const dependencies = new Set(Object.keys(metadata.dependencies));
    /** @param {URL} directory */
    function inspect(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) { inspect(url); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const source = readFileSync(url, 'utf8');
        const imports = source.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g);
        for (const match of imports) {
          const specifier = match[1] ?? match[2];
          if (specifier.startsWith('.')) {
            expect(fileURLToPath(new URL(specifier, url)).startsWith(fileURLToPath(root)), `${url.pathname}: ${specifier}`).toBe(true);
          } else {
            const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
            expect(isBuiltin(specifier) || dependencies.has(name), `${url.pathname}: ${specifier}`).toBe(true);
          }
        }
      }
    }
    inspect(new URL('src/', root));
  });
});
