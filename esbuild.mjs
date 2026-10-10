import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], sourcemap: true });
// Webviews use VS Code's own icon font so their icons match the workbench (CC BY 4.0; see THIRD_PARTY_NOTICES.txt).
await mkdir('media/codicons', { recursive: true });
for (const name of ['codicon.css', 'codicon.ttf']) await copyFile(`node_modules/@vscode/codicons/dist/${name}`, `media/codicons/${name}`);
