import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('manifest localization and menu commands resolve without duplicate contributions',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8'));
  assert.equal(manifest.license,'MIT');
  assert.ok(readFileSync('LICENSE','utf8').startsWith('MIT License\n\nCopyright (c) 2026 longtd\n'));
  const messages=JSON.parse(readFileSync('package.nls.json','utf8')) as Record<string,string>;
  const visit=(value:unknown):void=>{if(typeof value==='string'&&/^%[^%]+%$/.test(value))assert.ok(messages[value.slice(1,-1)]?.trim(),`Missing ${value}`);else if(value&&typeof value==='object')for(const nested of Object.values(value))visit(nested);};visit(manifest);
  const ids=manifest.contributes.commands.map((item:{command:string})=>item.command) as string[];assert.equal(new Set(ids).size,ids.length);
  for(const menu of Object.values(manifest.contributes.menus) as {command:string}[][])for(const item of menu)assert.ok(ids.includes(item.command),`Unregistered contribution ${item.command}`);
  assert.equal(manifest.contributes.views.gitPro.find((view:{id:string})=>view.id==='gitPro.changes')?.type,'webview','Changes uses a custom view so status can align at the far edge');
  const itemMenu=manifest.contributes.menus['view/item/context'] as {command:string;when:string;group:string}[];
  for(const command of ['gitPro.branchActions','gitPro.repositoryTools'])assert.ok(itemMenu.some(item=>item.command===command&&item.group!=='inline'),`${command} must be available from the right-click menu`);
  assert.ok(!itemMenu.some(item=>item.when.includes('view == gitPro.changes')),'Tree-only menu clauses must not remain after the Changes view switch');
  assert.ok(itemMenu.some(item=>item.command==='gitPro.repositoryTools'&&item.when.includes('gitPro.toolsView')&&item.when.includes('gitPro.tools')),'Repository Tools context action is scoped to its own view items');
  assert.equal(manifest.contributes.keybindings,undefined,'No default shortcuts before collision review');
});
