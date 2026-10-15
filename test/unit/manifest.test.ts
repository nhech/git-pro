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
  // The Quick Pick of actions stays one click away on every item; the right-click menu lists each of its choices natively.
  for(const command of ['gitPro.branchActions','gitPro.repositoryTools'])assert.ok(itemMenu.some(item=>item.command===command&&item.group==='inline'),`${command} stays available as the inline button`);
  for(const command of ['gitPro.branch.checkout','gitPro.branch.rename','gitPro.branch.delete','gitPro.repository.fetch','gitPro.tools.stash.apply','gitPro.tools.tag.push'])assert.ok(itemMenu.some(item=>item.command===command&&item.group!=='inline'),`${command} is in the right-click menu`);
  assert.ok(!itemMenu.some(item=>item.when.includes('view == gitPro.changes')),'Tree-only menu clauses must not remain after the Changes view switch');
  assert.ok(itemMenu.some(item=>item.command==='gitPro.repositoryTools'&&item.when.includes('gitPro.toolsView')&&item.when.includes('gitPro.tools')),'Repository Tools context action is scoped to its own view items');
  assert.equal(manifest.contributes.keybindings,undefined,'No default shortcuts before collision review');
});

/** The subset of VS Code when-clause syntax the manifest uses; `seen` collects every context key the clause reads. */
function when(clause:string,context:Record<string,unknown>,seen=new Set<string>()):boolean{
  const tokens=clause.match(/\/(?:\\.|[^/\\])*\/[a-z]*|==|!=|=~|&&|\|\||!|\(|\)|[^\s()!&|=]+/g)??[];let index=0;
  const peek=()=>tokens[index],next=()=>{const token=tokens[index++];assert.ok(token!==undefined,`Truncated when clause: ${clause}`);return token;};
  const key=(name:string)=>{if(name==='true'||name==='false')return name==='true';seen.add(name);return context[name];};
  const primary=():boolean=>{
    const token=next();
    if(token==='!')return !primary();
    if(token==='('){const result=or();assert.equal(next(),')',clause);return result;}
    const left=key(token),operator=peek();
    if(operator==='=='||operator==='!='){next();const equal=String(left)===next();return operator==='=='?equal:!equal;}
    if(operator==='=~'){next();const literal=/^\/(.*)\/([a-z]*)$/.exec(next());assert.ok(literal,clause);return new RegExp(literal[1]!,literal[2]).test(typeof left==='string'?left:'');}
    if(operator==='in'){next();const list=key(next());return Array.isArray(list)&&list.includes(left);}
    return !!left;
  };
  const and=():boolean=>{let result=primary();while(peek()==='&&'){next();const right=primary();result=result&&right;}return result;};
  const or=():boolean=>{let result=and();while(peek()==='||'){next();const right=and();result=result||right;}return result;};
  const result=or();assert.equal(index,tokens.length,`Unparsed when clause: ${clause}`);return result;
}
test('conflict and compare contributions use stable menus, owned context keys, localized titles and hidden argument-only commands',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8'));
  const messages=JSON.parse(readFileSync('package.nls.json','utf8')) as Record<string,string>;
  type Command={command:string;title:string;category?:string};type Item={command:string;when?:string;group?:string};
  const commands=manifest.contributes.commands as Command[],menus=manifest.contributes.menus as Record<string,Item[]>;
  const titles:Record<string,string>={
    'gitPro.conflicts.open':'Resolve Conflicts…','gitPro.conflicts.acceptYours':'Accept Yours','gitPro.conflicts.acceptTheirs':'Accept Theirs','gitPro.conflicts.merge':'Merge…',
    'gitPro.mergeEditor.apply':'Apply & Next Conflict (Save and Stage the Result)','gitPro.mergeEditor.nextFile':'Next Conflicted File','gitPro.mergeEditor.back':'Back to Conflicts',
    'gitPro.operation.menu':'Operation Actions…','gitPro.operation.continue':'Continue Operation…','gitPro.operation.abort':'Abort Operation…','gitPro.operation.skip':'Skip Commit…',
    'gitPro.compareWithCurrent':'Compare with Current','gitPro.diffWithWorkingTree':'Show Diff with Working Tree','gitPro.compareBranches':'Compare Branches','gitPro.compareWithRef':'Compare with Branch or Tag…',
    'gitPro.mergeIntoCurrent':'Merge into Current…','gitPro.rebaseCurrentOnto':'Rebase Current onto This…'
  };
  for(const item of commands){
    assert.equal(item.title,`%command.${item.command}.title%`,`${item.command} has an nls title key`);assert.equal(item.category,'%command.category%',`${item.command} is in the Git Pro category`);
    assert.ok(messages[`command.${item.command}.title`]?.trim(),`${item.command} title is localized`);
  }
  for(const [id,title] of Object.entries(titles))assert.equal(messages[`command.${id}.title`],title,`${id} title`);
  assert.equal(manifest.contributes.keybindings,undefined,'Shortcuts stay inside Git Pro webviews; every action is a bindable command');
  assert.equal(manifest.enabledApiProposals,undefined,'No proposed API');
  // Merge-editor and multi-diff menu points other than editor/title are proposed API.
  assert.deepEqual(Object.keys(menus).filter(id=>!['view/title','view/item/context','editor/context','editor/title','editor/title/context','explorer/context','commandPalette','webview/context'].includes(id)),[]);
  const views=new Set((manifest.contributes.views.gitPro as {id:string}[]).map(view=>view.id));
  const owned=new Set(['gitPro.hasRepositories','gitPro.hasConflicts','gitPro.conflictResources','gitPro.operation']);
  const builtIn=new Set(['view','viewItem','resource','resourceScheme','isMergeEditor','mergeEditorResultUri','listMultiSelection','listDoubleSelection','explorerResourceIsFolder','webviewId','webviewSection',
    // Plain values a panel puts on its elements (data-vscode-context) for its own menu items to read.
    'commitShown','compareWorktree','fileOnlyInBranch','conflictUnresolved','conflictFile','conflictMarkable','stepAction','stepFirst','stepLast']);
  for(const [menu,items] of Object.entries(menus))for(const item of items){
    if(item.when===undefined)continue;const seen=new Set<string>();when(item.when,{},seen);
    for(const name of seen)assert.ok(owned.has(name)||builtIn.has(name),`${menu} ${item.command} reads unknown context key ${name}`);
    for(const match of item.when.matchAll(/\bview == ([\w.]+)/g))assert.ok(views.has(match[1]!),`${menu} ${item.command} names unknown view ${match[1]}`);
  }
  const shown=(menu:string,command:string,context:Record<string,unknown>)=>menus[menu]!.filter(item=>item.command===command).some(item=>item.when===undefined||when(item.when,context));
  const palette=(command:string,context:Record<string,unknown>)=>{const item=menus.commandPalette!.find(entry=>entry.command===command);return !item?.when||when(item.when,context);};
  const argumentOnly=['gitPro.conflicts.acceptYours','gitPro.conflicts.acceptTheirs','gitPro.conflicts.merge','gitPro.compareBranches','gitPro.mergeIntoCurrent','gitPro.rebaseCurrentOnto',
    // Menu-only: each needs the tree item or folder it was invoked on, so from the palette it would do nothing useful.
    'gitPro.openFile','gitPro.stageFolder','gitPro.unstageFolder','gitPro.discardFolder',
    // Webview menu commands take the object the panel's context menu passes, so the palette has nothing to give them.
    ...(manifest.contributes.menus['webview/context'] as Item[]).map(item=>item.command),
    // The same for the entries of the Branches, Repositories and Repository Tools views' own menus: they take the item they were opened on.
    ...(menus['view/item/context'] as Item[]).map(item=>item.command).filter(command=>/^gitPro\.(?:branch|repository|tools)\./.test(command))];
  assert.deepEqual(menus.commandPalette!.filter(item=>item.when==='false').map(item=>item.command).sort(),[...argumentOnly].sort(),'argument-only commands are hidden from the palette');
  for(const id of ['gitPro.conflicts.open','gitPro.operation.menu','gitPro.compareWithCurrent','gitPro.diffWithWorkingTree','gitPro.compareWithRef'])assert.ok(palette(id,{}),`${id} stays in the palette`);
  const merging={'gitPro.operation':'merging','gitPro.hasConflicts':true},rebasing={'gitPro.operation':'rebasing'},idle={'gitPro.operation':'idle'};
  assert.ok(palette('gitPro.operation.continue',merging)&&palette('gitPro.operation.abort',rebasing)&&!palette('gitPro.operation.continue',idle));
  assert.ok(!palette('gitPro.operation.skip',merging)&&palette('gitPro.operation.skip',rebasing),'a merge cannot skip');
  // Branches view: Compare/Diff/Merge/Rebase are hidden for the current branch and for multi-selection; Compare Branches needs exactly two.
  const branch=(viewItem:string,selected:number)=>({view:'gitPro.branchesView',viewItem,listMultiSelection:selected>1,listDoubleSelection:selected===2});
  const single=['gitPro.compareWithCurrent','gitPro.diffWithWorkingTree','gitPro.mergeIntoCurrent','gitPro.rebaseCurrentOnto'];
  for(const viewItem of ['gitPro.branch.local','gitPro.branch.remote']){
    for(const id of single){assert.ok(shown('view/item/context',id,branch(viewItem,1)),`${id} for ${viewItem}`);assert.ok(!shown('view/item/context',id,branch(viewItem,2)),`${id} hidden for two branches`);}
    assert.ok(shown('view/item/context','gitPro.compareBranches',branch(viewItem,2))&&!shown('view/item/context','gitPro.compareBranches',branch(viewItem,1))&&!shown('view/item/context','gitPro.compareBranches',branch(viewItem,3)),'Compare Branches for exactly two');
  }
  for(const id of single)assert.ok(!shown('view/item/context',id,branch('gitPro.branch.current',1)),`${id} hidden for the current branch`);
  for(const viewItem of ['gitPro.branch.local','gitPro.branch.remote','gitPro.branch.current'])assert.ok(shown('view/item/context','gitPro.branchActions',branch(viewItem,1)),`Branch Actions for ${viewItem}`);
  assert.ok(!shown('view/item/context','gitPro.compareWithCurrent',{...branch('gitPro.branch.local',1),view:'gitPro.toolsView'}));
  // Merge editor buttons only on a Git Pro conflict Result; Merge… only on a conflicted file outside the merge editor.
  const conflictUri='file:///repo/app.ts',resources={'gitPro.conflictResources':[conflictUri],resourceScheme:'file'};
  const inMerge={...resources,isMergeEditor:true,mergeEditorResultUri:conflictUri,resource:conflictUri},inEditor={...resources,isMergeEditor:false,resource:conflictUri};
  for(const id of ['gitPro.mergeEditor.apply','gitPro.mergeEditor.nextFile','gitPro.mergeEditor.back']){
    assert.ok(shown('editor/title',id,inMerge),`${id} in a conflict merge editor`);assert.ok(!shown('editor/title',id,{...inMerge,mergeEditorResultUri:'file:///repo/other.ts'}),`${id} hidden for other merge editors`);assert.ok(!shown('editor/title',id,inEditor));
  }
  assert.deepEqual(menus['editor/title']!.filter(item=>item.command.startsWith('gitPro.mergeEditor.')).map(item=>item.group),['navigation@1','navigation@2','navigation@3']);
  assert.ok(shown('editor/title','gitPro.conflicts.merge',inEditor)&&!shown('editor/title','gitPro.conflicts.merge',inMerge)&&!shown('editor/title','gitPro.conflicts.merge',{...inEditor,resource:'file:///repo/clean.ts'}));
  assert.ok(shown('view/title','gitPro.conflicts.open',{view:'gitPro.changes','gitPro.hasConflicts':true})&&!shown('view/title','gitPro.conflicts.open',{view:'gitPro.changes','gitPro.hasConflicts':false}));
  const file={resourceScheme:'file','gitPro.hasRepositories':true,explorerResourceIsFolder:false};
  assert.ok(shown('explorer/context','gitPro.compareWithRef',file)&&shown('explorer/context','gitPro.compareWithRef',{...file,explorerResourceIsFolder:true})&&shown('editor/title/context','gitPro.compareWithRef',file));
  const settings=manifest.contributes.configuration.properties as Record<string,{type:string;enum?:string[];default:unknown;scope:string;description:string}>;
  assert.deepEqual([settings['gitPro.conflicts.autoOpen']?.enum,settings['gitPro.conflicts.autoOpen']?.default],[['gitPro','always','never'],'gitPro']);
  assert.deepEqual([settings['gitPro.conflicts.groupByDirectory']?.type,settings['gitPro.conflicts.groupByDirectory']?.default],['boolean',false]);
  assert.deepEqual([settings['gitPro.compare.defaultFilesMode']?.enum,settings['gitPro.compare.defaultFilesMode']?.default],[['fork','tips'],'fork']);
  for(const id of ['gitPro.conflicts.autoOpen','gitPro.conflicts.groupByDirectory','gitPro.compare.defaultFilesMode'])assert.equal(settings[id]?.scope,'resource',id);
  assert.equal(settings['gitPro.mergeEditor.sideOrder'],undefined,'Pane order is fixed to Yours | Result | Theirs in v1');
});

test('the Branches view context menu offers Compare with Another Branch… for local, remote and the checked-out branch, and the others only where they apply',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {contributes:{menus:Record<string,{command:string;when?:string;group?:string}[]>}};
  const entries=manifest.contributes.menus['view/item/context']!;
  const shows=(command:string,viewItem:string)=>entries.filter(entry=>entry.command===command).some(entry=>{
    const pattern=/viewItem =~ \/(.+?)\/(?= |$)/.exec(entry.when??'');
    return entry.when?.includes('view == gitPro.branchesView')===true&&entry.when.includes('!listMultiSelection')&&(!pattern||new RegExp(pattern[1]!).test(viewItem));
  });
  for(const viewItem of ['gitPro.branch.local','gitPro.branch.remote','gitPro.branch.current'])assert.ok(shows('gitPro.compareWithBranch',viewItem),`Compare with Another Branch… is offered on ${viewItem}`);
  for(const command of ['gitPro.compareWithCurrent','gitPro.diffWithWorkingTree','gitPro.mergeIntoCurrent','gitPro.rebaseCurrentOnto']){
    assert.ok(shows(command,'gitPro.branch.local')&&shows(command,'gitPro.branch.remote'),`${command} is offered on other branches`);
    assert.ok(!shows(command,'gitPro.branch.current'),`${command} is hidden on the checked-out branch`);
  }
  assert.ok(!shows('gitPro.compareWithBranch','gitPro.tools'),'it is not offered on other views\' items');
  assert.ok(!shows('gitPro.compareWithBranch','gitProXbranchXlocal'),'the dots of the context pattern are escaped, not wildcards');
});

test('the Branches view title offers Search, Fetch and Refresh for open repositories',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {contributes:{menus:Record<string,{command:string;when?:string;group?:string}[]>}};
  const title=manifest.contributes.menus['view/title']!.filter(entry=>entry.when?.includes('view == gitPro.branchesView')===true);
  assert.deepEqual(title.map(entry=>entry.command).sort(),['gitPro.branches','gitPro.fetch','gitPro.refresh']);
  assert.ok(title.every(entry=>/^navigation(@\d+)?$/.test(entry.group??'')),'all three are icon buttons');
  for(const command of ['gitPro.fetch','gitPro.refresh'])assert.ok(title.find(entry=>entry.command===command)?.when?.includes('gitPro.hasRepositories'),`${command} needs an open repository`);
});

test('the welcome text and the workspace capability notes are localizable, not literal',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {capabilities:Record<string,{description?:string}>;contributes:{viewsWelcome:{contents:string}[]}};
  const messages=JSON.parse(readFileSync('package.nls.json','utf8')) as Record<string,string>;
  const texts=[...Object.values(manifest.capabilities).map(entry=>entry.description??''),...manifest.contributes.viewsWelcome.map(entry=>entry.contents)];
  assert.equal(texts.length,3);
  for(const text of texts){assert.match(text,/^%[\w.]+%$/,`${text} is an nls reference`);assert.ok(messages[text.slice(1,-1)]?.trim());}
});

test('webview context menus: every item names a panel and a section, is hidden from the palette and sorts into the same groups as the Source Control Graph',()=>{
  const manifest=JSON.parse(readFileSync('package.json','utf8')) as {contributes:{commands:{command:string;title:string}[];menus:Record<string,{command:string;when?:string;group?:string}[]>}};
  const messages=JSON.parse(readFileSync('package.nls.json','utf8')) as Record<string,string>;
  const menu=manifest.contributes.menus['webview/context']!,hidden=new Set(manifest.contributes.menus.commandPalette!.filter(item=>item.when==='false').map(item=>item.command));
  assert.ok(menu.length>=10,'the commit menu exists');
  for(const item of menu){
    assert.match(item.when??'',/webviewId == 'gitPro\.[A-Za-z]+'/,`${item.command} names its panel`);assert.match(item.when??'',/webviewSection == '[a-z-]+'/,`${item.command} names its section`);
    assert.match(item.group??'',/^\d_[a-z]+@\d+$/,`${item.command} has a group@order`);assert.ok(hidden.has(item.command),`${item.command} is hidden from the palette`);
    assert.ok(messages[`command.${item.command}.title`],`${item.command} has a localized title`);
  }
  const commit=menu.filter(item=>item.when?.includes("webviewSection == 'commit'")&&item.command.startsWith('gitPro.menu.commit.'));
  assert.deepEqual(commit.map(item=>item.group).sort(),['1_checkout@1','1_checkout@2','1_checkout@3','2_modify@1','2_modify@2','2_modify@3','3_compare@1','3_compare@2','9_copy@1','9_copy@2'],'groups never collide, so the order is stable');
  assert.ok(commit.every(item=>item.when?.includes("webviewId == 'gitPro.history'")&&item.when.includes("webviewId == 'gitPro.compare'")),'History and Compare share the commit menu');
  // Whatever one panel adds to its own rows takes a group of its own, so the order of a menu never depends on how VS Code breaks a tie.
  for(const panel of ['history','compare','conflicts','rebasePlanner'])for(const section of ['commit','file','conflict','step']){
    const groups=menu.filter(item=>item.when?.includes(`webviewId == 'gitPro.${panel}'`)&&item.when.includes(`webviewSection == '${section}'`)).map(item=>item.group);
    assert.equal(new Set(groups).size,groups.length,`${panel} ${section} menu groups are unique`);
  }
});
