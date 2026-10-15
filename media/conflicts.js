(() => {
  const vscode=acquireVsCodeApi(),byId=id=>document.getElementById(id);
  const rowsEl=byId('rows'),table=byId('table'),statusEl=byId('status'),emptyEl=byId('empty'),more=byId('more'),hint=byId('hint'),banner=byId('banner'),titleEl=byId('title'),counterEl=byId('counter');
  const sidesEl=byId('sides'),yoursSide=byId('yours-side'),theirsSide=byId('theirs-side'),operationBar=byId('operation-actions'),toggle=byId('group-by-directory'),yoursHeader=byId('yours-header'),theirsHeader=byId('theirs-header');
  const buttons={acceptYours:byId('accept-yours'),acceptTheirs:byId('accept-theirs'),merge:byId('merge'),compare:byId('compare')},overflow=byId('overflow');
  const kinds={bothModified:'Both modified',bothAdded:'Both added',deletedByUs:'Deleted by us',deletedByThem:'Deleted by them',addedByUs:'Added by us',addedByThem:'Added by them',bothDeleted:'Both deleted'};
  const sideText={modified:'Modified',added:'Added',deleted:'Deleted',absent:'—'},sideName={modified:'Modified',added:'Added',deleted:'Deleted',absent:'Absent'};
  const verbs={merging:'Merge',rebasing:'Rebase','cherry-picking':'Cherry-pick',reverting:'Revert'};
  const menuIcons={merge:'git-merge',acceptYours:'arrow-left',acceptTheirs:'arrow-right',file:'go-to-file',markResolved:'check',compareBaseYours:'diff',compareBaseTheirs:'diff',compareYoursTheirs:'diff',columnLayout:'split-horizontal'};
  const compareEntries=[['compareBaseYours','Compare Base ↔ Yours'],['compareBaseTheirs','Compare Base ↔ Theirs'],['compareYoursTheirs','Compare Yours ↔ Theirs']],overflowEntries=[['columnLayout','Use Column Layout in Merge Editor']];
  const session=document.body.dataset.session||'',selected=new Set(),collapsed=new Set();
  let state={rows:[],operation:null,message:'Loading conflicts…',groupByDirectory:false,truncated:false,columnLayout:false},revision=0,items=[],byKey=new Map(),elements=new Map();
  let busy=false,menu,menuOwner,focusedKey='',anchorKey='',visibleCount=200,identity='',hintSide='yours',swallow=false,unresolvedBefore=-1,initial=true;
  document.body.setAttribute?.('data-vscode-context',JSON.stringify({preventDefaultContextMenuItems:true}));
  const send=message=>{if(session)vscode.postMessage({...message,session});};
  const create=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const icon=name=>{const node=create('span',`codicon codicon-${name}`);node.setAttribute('aria-hidden','true');return node;};
  const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
  const short=oid=>typeof oid==='string'?oid.slice(0,7):'';
  const sideLabel=side=>side?[side.ref,short(side.oid)].filter(Boolean).join(' · '):'';
  const announce=(text,error=false)=>{statusEl.textContent=text;statusEl.classList.toggle('error',error);};
  // Modify/delete and add/rename rows: the working file is only the side Git kept, so it has no markers to count and staging it as is would pick that side (N13).
  const bothSides=row=>row.kind==='bothModified'||row.kind==='bothAdded';
  const stateText=row=>row.group==='resolved'?'Resolved':row.unsupported?row.unsupported:row.binary?'Binary':!row.workingFile?'No working file':!bothSides(row)?'Choose Yours or Theirs':row.markers==='unknown'?'Not counted':row.markers==='none'?'No markers left':row.blocks?`${plural(row.blocks,'conflict')} left`:'Markers present';
  const mergeReason=row=>row.binary?'Binary file — choose Accept Yours or Accept Theirs.':row.kind==='bothModified'||row.kind==='bothAdded'?row.workingFile?'Not mergeable as text — choose Accept Yours or Accept Theirs.':'No working file — choose Accept Yours or Accept Theirs.':`${kinds[row.kind]||'This conflict'} — choose Accept Yours or Accept Theirs.`;
  // Group rows, then (optionally) one directory level, then files; the host's path order is kept inside each level.
  const build=()=>{
    const result=[];
    for(const [group,label] of [['unresolved','Unresolved'],['resolved','Resolved']]){
      const files=state.rows.filter(row=>row.group===group);if(!files.length)continue;
      const groupKey=`group:${group}`;result.push({type:'group',key:groupKey,group,label,count:files.length,depth:0});
      if(!state.groupByDirectory){for(const row of files)result.push({...row,type:'file',depth:1,parent:groupKey});continue;}
      const directories=new Map();
      for(const row of files){const slash=row.path.lastIndexOf('/'),directory=slash>0?row.path.slice(0,slash):'';if(!directories.has(directory))directories.set(directory,[]);directories.get(directory).push(row);}
      for(const directory of [...directories.keys()].sort()){
        const parent=directory?`dir:${group}:${directory}`:groupKey,entries=directories.get(directory);
        if(directory)result.push({type:'dir',key:parent,group,label:directory,count:entries.length,depth:1,parent:groupKey});
        for(const row of entries)result.push({...row,type:'file',depth:directory?2:1,parent,grouped:true});
      }
    }
    return result;
  };
  const visible=item=>{let parent=item&&item.parent;while(parent){if(collapsed.has(parent))return false;parent=byKey.get(parent)?.parent;}return Boolean(item);};
  const shown=()=>items.filter(visible).slice(0,visibleCount);
  const selection=()=>items.filter(item=>item.type==='file'&&selected.has(item.key));
  // The reason an action is unavailable; the host checks everything again (N1, N12-N14), so this only explains.
  const blocker=(action,rows)=>{
    if(action==='columnLayout')return'';
    if(busy)return'Wait for the current action to finish.';
    if(action==='file')return rows.length===1?'':'Select one file to open.';
    if(!rows.length)return action==='compare'?'Select one conflicted file to compare.':'Select conflicted files first.';
    if(rows.some(row=>row.group!=='unresolved'))return'Select unresolved files only.';
    const unsupported=rows.find(row=>row.unsupported);if(unsupported)return`${unsupported.path}: ${unsupported.unsupported}`;
    if(action==='merge'){const row=rows.find(row=>!row.mergeable);return row?`${row.path}: ${mergeReason(row)}`:'';}
    if(action==='compare')return rows.length!==1?'Select one conflicted file to compare.':rows[0].binary?'Binary file — no text compare.':'';
    const open=rows.find(row=>row.mergeOpen);if(open)return`Close the merge editor for ${open.path} first.`;
    if(action==='markResolved'){
      const binary=rows.find(row=>row.binary);if(binary)return`${binary.path} is binary. Choose Accept Yours or Accept Theirs.`;
      const missing=rows.find(row=>!row.workingFile);if(missing)return`${missing.path} has no working file. Choose Accept Yours or Accept Theirs.`;
      const oneSided=rows.find(row=>!bothSides(row));if(oneSided)return`${oneSided.path} is ${(kinds[oneSided.kind]||'a one-sided conflict').toLowerCase()}: Mark Resolved would keep only the version Git left in the working tree. Choose Accept Yours or Accept Theirs.`;
      const marked=rows.find(row=>row.markers==='present');if(marked)return`Conflict markers remain in ${marked.path}. Use Merge… first.`;
    }
    return'';
  };
  const run=(action,rows=selection())=>{
    // A view preference for the next merge editor: no rows, no revision.
    if(action==='columnLayout'){send({type:'columnLayout'});return true;}
    const reason=blocker(action.startsWith('compare')?'compare':action,rows);
    if(reason){announce(reason);return false;}
    const keys=rows.map(row=>row.key);
    if(action==='merge')send({type:'open',revision,action:'merge',key:keys[0],keys});
    else if(action==='file'||action.startsWith('compare'))send({type:'open',revision,action,key:keys[0]});
    else send({type:'resolve',revision,action,keys});
    return true;
  };
  const publish=()=>send({type:'select',keys:[...selected]});
  const selectOnly=item=>{if(selected.size===1&&selected.has(item.key))return;selected.clear();selected.add(item.key);anchorKey=item.key;publish();renderSelection();};
  const selectRow=(item,event)=>{
    if(item.type!=='file')return;
    // An anchor whose row left the table (resolved rows get new keys) no longer anchors anything.
    const anchored=byKey.get(anchorKey)?.type==='file';
    if(event.ctrlKey||event.metaKey){if(selected.has(item.key))selected.delete(item.key);else if(selected.size<100)selected.add(item.key);else announce('Select up to 100 files at a time.');}
    else if(event.shiftKey&&anchored){
      const files=shown().filter(row=>row.type==='file'),from=files.findIndex(row=>row.key===anchorKey),to=files.findIndex(row=>row.key===item.key);selected.clear();
      if(from>=0&&to>=0)for(const row of files.slice(Math.min(from,to),Math.max(from,to)+1).slice(0,100))selected.add(row.key);else selected.add(item.key);
    }else{selected.clear();selected.add(item.key);}
    if(!event.shiftKey||!anchored)anchorKey=item.key;focusedKey=item.key;publish();renderSelection();
  };
  const selectAll=()=>{
    const files=items.filter(item=>item.type==='file'&&item.group==='unresolved'&&visible(item));selected.clear();for(const row of files.slice(0,100))selected.add(row.key);
    if(files.length>100)announce('Selected the first 100 files. Actions apply to up to 100 files at a time.');publish();renderSelection();
  };
  const focusRow=key=>{const node=elements.get(key);if(!node)return;focusedKey=key;for(const [other,element] of elements)element.tabIndex=other===key?0:-1;node.focus();};
  const toggleGroup=item=>{if(collapsed.has(item.key))collapsed.delete(item.key);else collapsed.add(item.key);renderRows();focusRow(item.key);};
  // Enter and double-click: Merge… for a mergeable row; otherwise the Accept buttons get focus and the reason is announced (§3.2).
  const enter=item=>{
    if(item.group==='unresolved'&&item.mergeable&&!item.unsupported){selectOnly(item);run('merge',[item]);return;}
    selectOnly(item);announce(item.group==='resolved'?`${item.path} is resolved.`:item.unsupported||mergeReason(item));
    if(item.group==='unresolved'&&!item.unsupported)buttons.acceptYours.focus();
  };
  // Focus goes back to what opened the menu: the Compare or overflow button (menu-button pattern), otherwise the row.
  const closeMenu=restore=>{if(!menu)return;menu.remove();menu=undefined;const owner=menuOwner;menuOwner=undefined;if(restore){if(owner)owner.focus();else focusRow(focusedKey);}};
  // Right-click on a row is VS Code's own menu (contributes.menus["webview/context"]); the host knows the selection, the row names itself and the revision it was drawn for.
  // The Compare and overflow buttons still open a menu of ours: a native menu cannot be opened from a button.
  const showMenu=(point,entries,owner,label)=>{
    closeMenu(false);menuOwner=owner;
    const list=entries;if(!list.length)return;
    menu=create('div','context-menu');menu.setAttribute('role','menu');menu.setAttribute('aria-label',label);
    for(const entry of list){
      if(!entry){if(menu.children.length&&menu.children[menu.children.length-1].className!=='menu-separator'){const separator=create('div','menu-separator');separator.setAttribute('role','separator');menu.append(separator);}continue;}
      const [action,text]=entry,single=action==='file'||action.startsWith('compare')||action==='columnLayout',targets=single?[selection()[0]].filter(Boolean):selection();
      const reason=blocker(action.startsWith('compare')?'compare':action,targets),button=create('button','menu-item');
      button.type='button';button.setAttribute('role','menuitem');button.dataset.menuAction=action;button.append(icon(menuIcons[action]),create('span','menu-label',!single&&targets.length>1?`${text} (${targets.length})`:text));
      if(reason){button.setAttribute('aria-disabled','true');button.title=reason;}
      button.addEventListener('click',()=>{if(reason){announce(reason);return;}closeMenu(true);run(action,targets);});
      menu.append(button);
    }
    menu.addEventListener('keydown',event=>{
      const options=[...menu.children].filter(node=>node.getAttribute('role')==='menuitem'),index=options.indexOf(document.activeElement);let next;
      if(event.key==='ArrowDown')next=options[(index+1)%options.length];else if(event.key==='ArrowUp')next=options[(index-1+options.length)%options.length];
      else if(event.key==='Home')next=options[0];else if(event.key==='End')next=options[options.length-1];else if(event.key==='Tab'){event.preventDefault();closeMenu(true);return;}else return;
      event.preventDefault();next?.focus();
    });
    document.body.append(menu);const rect=menu.getBoundingClientRect();
    menu.style.left=`${Math.max(4,Math.min(point.clientX,innerWidth-rect.width-4))}px`;menu.style.top=`${Math.max(4,Math.min(point.clientY,innerHeight-rect.height-4))}px`;
    [...menu.children].find(node=>node.getAttribute('role')==='menuitem')?.focus();
  };
  const tagRow=(node,item)=>node.setAttribute('data-vscode-context',JSON.stringify({preventDefaultContextMenuItems:true,session,revision,webviewSection:'conflict',key:item.key,conflictUnresolved:item.group==='unresolved',conflictFile:item.workingFile===true,
    conflictMarkable:item.group==='unresolved'&&item.markers!=='present'&&!item.binary&&!item.unsupported&&item.workingFile===true&&bothSides(item)}));
  const cell=(className,text)=>{const node=create('span',`cell ${className}`,text);node.setAttribute('role','gridcell');return node;};
  const fileNode=item=>{
    const node=create('div',`row file ${item.group} depth-${Math.min(item.depth,4)}${item.mergeOpen?' merge-open':''}`),status=stateText(item);
    node.dataset.key=item.key;node.setAttribute('role','row');node.setAttribute('aria-level',String(item.depth+1));node.setAttribute('aria-selected',String(selected.has(item.key)));node.tabIndex=item.key===focusedKey?0:-1;
    node.setAttribute('aria-label',`${item.path}, ${kinds[item.kind]}, Yours ${sideName[item.yours]}, Theirs ${sideName[item.theirs]}, ${status}${item.mergeOpen?', open in the merge editor':''}`);node.title=item.path;
    // The text stays the exact path; the file name comes first and its directory is dimmed, as in the Changes view.
    const name=cell('col-name'),slash=item.path.lastIndexOf('/');
    name.append(icon(item.group==='resolved'?'pass':item.unsupported?'circle-slash':'warning'),create('span','base',slash>=0?item.path.slice(slash+1):item.path));
    if(slash>0&&!item.grouped)name.append(create('span','dir',item.path.slice(0,slash)));
    name.append(create('span','kind-inline',kinds[item.kind]));
    node.append(name,cell('col-kind',kinds[item.kind]),cell(`col-side side-${item.yours}`,sideText[item.yours]),cell(`col-side side-${item.theirs}`,sideText[item.theirs]),cell('col-state',item.mergeOpen?`${status} · In merge editor`:status));
    node.addEventListener('focus',()=>{focusedKey=item.key;for(const [other,element] of elements)element.tabIndex=other===item.key?0:-1;});
    node.addEventListener('click',event=>{closeMenu(false);focusRow(item.key);selectRow(item,event);});
    node.addEventListener('dblclick',()=>enter(item));
    // A right-click outside the selection selects just that row before the native menu opens, as in the Explorer.
    node.addEventListener('contextmenu',()=>{focusedKey=item.key;if(!selected.has(item.key))selectOnly(item);});
    tagRow(node,item);
    node.addEventListener('keydown',event=>keydown(item,node,event));
    return node;
  };
  const groupNode=item=>{
    const node=create('div',`row ${item.type} ${item.group} depth-${item.depth}`);node.dataset.key=item.key;node.setAttribute('role','row');node.setAttribute('aria-level',String(item.depth+1));
    node.setAttribute('aria-expanded',String(!collapsed.has(item.key)));node.setAttribute('aria-label',`${item.label}, ${plural(item.count,'file')}`);node.tabIndex=item.key===focusedKey?0:-1;
    const name=cell('col-name'),disclosure=create('span','disclosure');disclosure.setAttribute('aria-hidden','true');name.setAttribute('aria-colspan','5');
    name.append(disclosure,...(item.type==='dir'?[icon('folder')]:[]),create('span','base',item.label),create('span','count',String(item.count)));node.append(name);
    node.addEventListener('focus',()=>{focusedKey=item.key;for(const [other,element] of elements)element.tabIndex=other===item.key?0:-1;});
    node.addEventListener('click',()=>{closeMenu(false);toggleGroup(item);});
    node.addEventListener('keydown',event=>keydown(item,node,event));
    return node;
  };
  const keydown=(item,node,event)=>{
    // Select All belongs to the table: stopped here so the workbench does not also run it on the page.
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&String(event.key).toLowerCase()==='a'){event.preventDefault();event.stopPropagation();selectAll();return;}
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    if(event.key===' '){event.preventDefault();if(item.type==='file')selectRow(item,{ctrlKey:true});else toggleGroup(item);return;}
    if(event.key==='Enter'){event.preventDefault();if(item.type==='file')enter(item);else toggleGroup(item);return;}
    const list=shown(),index=list.findIndex(row=>row.key===item.key);let next;
    if(event.key==='ArrowDown')next=list[index+1];else if(event.key==='ArrowUp')next=list[index-1];else if(event.key==='Home')next=list[0];else if(event.key==='End')next=list[list.length-1];
    else if(event.key==='ArrowRight'&&item.type!=='file'){if(collapsed.has(item.key)){toggleGroup(item);return;}next=list.find(row=>row.parent===item.key);}
    else if(event.key==='ArrowLeft'){if(item.type!=='file'&&!collapsed.has(item.key)){toggleGroup(item);return;}next=list.find(row=>row.key===item.parent);}
    else return;
    event.preventDefault();if(!next)return;
    // Shift+Arrow extends from the row that had focus when no anchor is set yet (keyboard users reach rows by Tab, without a click).
    if(event.shiftKey&&next.type==='file'&&byKey.get(anchorKey)?.type!=='file')anchorKey=item.type==='file'?item.key:next.key;
    focusRow(next.key);if(event.shiftKey&&next.type==='file')selectRow(next,{shiftKey:true});
  };
  const setButton=(button,reason,text,iconName,name)=>{
    button.setAttribute('aria-disabled',String(Boolean(reason)));button.classList.toggle('disabled',Boolean(reason));button.title=reason||name;button.setAttribute('aria-label',name);
    button.children[0].className=`codicon codicon-${iconName}`;button.children[1].textContent=text;const described=byId(`reason-${button.dataset.action}`);if(described)described.textContent=reason;
  };
  const renderHint=rows=>{
    const op=state.operation,info=op&&op[hintSide];
    if(!info||!rows.length){hint.textContent=op&&state.rows.some(row=>row.group==='unresolved')?'Select files, then Accept Yours, Accept Theirs or Merge… (Alt+Y, Alt+T, Alt+M)':'';return;}
    const who=info.ref||short(info.oid)||(hintSide==='yours'?'your':'their');
    hint.textContent=`${rows.length} selected · Accept ${hintSide==='yours'?'Yours':'Theirs'} keeps ${who}'s version and stages it (git --${info.flag})`;
  };
  const renderActions=()=>{
    const rows=selection(),count=rows.length;
    for(const [action,side,arrow] of [['acceptYours','yours','arrow-left'],['acceptTheirs','theirs','arrow-right']]){
      const name=side==='yours'?'Yours':'Theirs',deletes=rows.filter(row=>row[side]==='deleted'||row[side]==='absent').length;
      setButton(buttons[action],blocker(action,rows),`Accept ${name}${deletes?` (delete ${plural(deletes,'file')})`:''}`,deletes?'trash':arrow,count?`Accept ${name} for ${plural(count,'file')}${deletes?`, deleting ${deletes}`:''}`:`Accept ${name}`);
    }
    setButton(buttons.merge,blocker('merge',rows),'Merge…','git-merge',count>1?`Merge ${plural(count,'file')} in sequence`:'Merge…');
    setButton(buttons.compare,blocker('compare',rows),'Compare','diff','Compare');
    renderHint(rows);
  };
  const renderSelection=()=>{for(const [key,node] of elements){if(byKey.get(key)?.type==='file')node.setAttribute('aria-selected',String(selected.has(key)));node.tabIndex=key===focusedKey?0:-1;}renderActions();};
  const operationButton=(action,text,iconName,primary,reason)=>{
    const button=create('button',primary?'primary':'secondary');button.type='button';button.dataset.operation=action;button.append(icon(iconName),create('span','label',text));
    button.title=reason||text;if(reason){button.setAttribute('aria-disabled','true');button.dataset.reason=reason;}
    button.addEventListener('click',()=>activateOperation(button));return button;
  };
  const activateOperation=button=>{
    if(button.getAttribute('aria-disabled')==='true'){announce(button.dataset.reason||'Unavailable.');return;}
    if(busy){announce('Wait for the current action to finish.');return;}
    send({type:'operation',revision,action:button.dataset.operation});
  };
  const renderBanner=()=>{
    const op=state.operation,resolved=state.rows.filter(row=>row.group==='resolved').length,verb=op&&verbs[op.kind];
    titleEl.textContent=op?op.title:'Conflicts';banner.setAttribute('aria-label',verb?`${verb} in progress`:'Conflicts');
    const progress=op&&op.progress?`Step ${op.progress.current} of ${op.progress.total} · `:'',limit=state.truncated?' · first 5000 listed':'';
    // A polite live region: rewritten only when the count changes, so a refresh is not announced again.
    const counted=!op||op.nativeOnly?'':op.conflicts?`${progress}${op.conflicts} of ${op.conflicts+resolved} unresolved${limit}`:verb||resolved?`${progress}All conflicts resolved${op.stash&&op.kind==='idle'?` · ${op.stash.selector} was kept`:''}`:'';
    if(counterEl.textContent!==counted)counterEl.textContent=counted;
    sidesEl.hidden=!op||op.nativeOnly||!op.conflicts&&!resolved;
    yoursSide.textContent=op?`Yours: ${sideLabel(op.yours)||'—'}${op.yours.subject?` “${op.yours.subject}”`:''}`:'';
    theirsSide.textContent=op?`Theirs: ${sideLabel(op.theirs)||'—'}${op.theirs.subject?` “${op.theirs.subject}”`:''}`:'';
    const controls=[];
    if(op&&op.nativeOnly)controls.push(operationButton('scm','Open Source Control','source-control',false,''));
    else if(verb){
      const done=op.conflicts===0;controls.push(operationButton('continue',`Continue ${verb}…`,'debug-continue',done&&op.canContinue,done?op.canContinue?'':'Continue is unavailable here.':'Resolve and stage all conflicts first.'));
      if(op.canSkip)controls.push(operationButton('skip','Skip Commit…','debug-step-over',false,''));
      if(op.canAbort)controls.push(operationButton('abort',`Abort ${verb}…`,'circle-slash',false,''));
    }else if(!op||!op.conflicts){if(op&&op.stash&&op.stash.drop)controls.push(operationButton('dropStash','Drop Stash…','trash',false,''));if(!state.message||!/^Loading/.test(state.message))controls.push(operationButton('close','Close','close',false,''));}
    // Busy and state updates rebuild the bar; a focused button keeps focus through it.
    const focused=operationBar.contains(document.activeElement)?document.activeElement.dataset.operation:undefined;
    operationBar.replaceChildren(...controls);if(focused)controls.find(button=>button.dataset.operation===focused)?.focus();
    // The last conflict resolved: the primary action takes focus (§3.2 Finish).
    const now=op?op.conflicts:-1;if(unresolvedBefore>0&&now===0){const primary=controls.find(button=>button.dataset.operation==='continue'&&button.getAttribute('aria-disabled')!=='true'||button.dataset.operation==='dropStash');if(primary)primary.focus();}
    unresolvedBefore=now;
  };
  const renderHeaders=()=>{
    const op=state.operation;
    for(const [header,side,name] of [[yoursHeader,op&&op.yours,'Yours'],[theirsHeader,op&&op.theirs,'Theirs']]){
      const ref=side?side.ref||short(side.oid):'',chip=header.children[0];chip.textContent=ref?`${name} (${ref})`:name;chip.title=chip.textContent;
      // The chip colour follows the Git side, matching the conflict decorations VS Code draws in the editor (§3.15).
      chip.className=`chip ${side&&side.flag==='theirs'?'theirs':'ours'}`;
    }
  };
  const renderRows=()=>{
    const restore=table.contains(document.activeElement),list=shown();
    if(!list.some(item=>item.key===focusedKey))focusedKey=list[0]?.key||'';
    rowsEl.replaceChildren();elements=new Map();
    for(const item of list){const node=item.type==='file'?fileNode(item):groupNode(item);elements.set(item.key,node);rowsEl.append(node);}
    const remaining=items.filter(visible).length-list.length;more.hidden=remaining<=0;more.textContent=`Show ${Math.min(200,remaining)} more (${remaining} remaining)`;
    if(restore)focusRow(focusedKey);renderSelection();
  };
  const render=()=>{
    renderBanner();renderHeaders();toggle.checked=state.groupByDirectory;overflow.hidden=state.columnLayout!==true;
    const empty=!state.rows.length,op=state.operation;table.hidden=empty;emptyEl.hidden=!empty;
    emptyEl.textContent=state.message||(op&&op.nativeOnly?`${op.title}.`:op&&verbs[op.kind]?'All conflicts resolved.':'No merge conflicts.');
    renderRows();
  };
  window.addEventListener('message',event=>{
    const data=event.data;if(!data||typeof data!=='object'||data.session!==session)return;
    if(data.type==='state'){
      if(Number.isSafeInteger(data.revision))revision=data.revision;
      const next={rows:Array.isArray(data.rows)?data.rows:[],operation:data.operation&&typeof data.operation==='object'?data.operation:null,message:typeof data.message==='string'?data.message:'',groupByDirectory:data.groupByDirectory===true,truncated:data.truncated===true,columnLayout:data.columnLayout===true};
      const nextIdentity=JSON.stringify([revision,next]);if(nextIdentity===identity)return;identity=nextIdentity;
      // Focus returns to the unresolved row now at the focused row's place: the next one after an action resolved it (§3.18).
      const previous=items.filter(item=>item.type==='file'&&item.group==='unresolved'),index=previous.findIndex(item=>item.key===focusedKey),focusSelected=selected.has(focusedKey);
      state=next;items=build();byKey=new Map(items.map(item=>[item.key,item]));
      for(const key of [...selected])if(byKey.get(key)?.type!=='file')selected.delete(key);
      for(const key of [...collapsed])if(!byKey.has(key))collapsed.delete(key);
      if(!byKey.has(focusedKey)){
        const unresolved=items.filter(item=>item.type==='file'&&item.group==='unresolved'&&visible(item)),target=unresolved[Math.min(Math.max(index,0),unresolved.length-1)];focusedKey=target?target.key:'';
        // The selection follows: the row taking the resolved one's place is selected, so Alt+T or Accept can run again at once, as in WebStorm.
        if(focusSelected&&!selected.size&&target){selected.add(target.key);anchorKey=target.key;}
      }
      if(byKey.get(anchorKey)?.type!=='file')anchorKey='';
      closeMenu(false);publish();render();
      // The tab opened with focus (not preserveFocus): the first unresolved row takes focus and selection, so the keyboard and Alt+Y/T/M work at once.
      const first=items.find(item=>item.type==='file'&&item.group==='unresolved');
      if(initial&&first){
        initial=false;const active=document.activeElement;
        if(typeof document.hasFocus==='function'&&document.hasFocus()&&(!active||active===document.body)){if(!selected.size){selected.add(first.key);anchorKey=first.key;publish();}focusRow(selected.has(focusedKey)?focusedKey:first.key);renderSelection();}
      }
      return;
    }
    if(data.type==='select'){
      const keys=Array.isArray(data.keys)?data.keys.filter(key=>byKey.get(key)?.type==='file').slice(0,100):[];if(!keys.length)return;
      selected.clear();for(const key of keys){selected.add(key);let parent=byKey.get(key).parent;while(parent){collapsed.delete(parent);parent=byKey.get(parent)?.parent;}}
      anchorKey=keys[0];focusedKey=keys[0];const position=items.filter(visible).findIndex(item=>item.key===keys[0]);if(position>=visibleCount)visibleCount=Math.ceil((position+1)/200)*200;
      renderRows();if(data.restore!==true)focusRow(keys[0]);publish();return;
    }
    if(data.type==='busy'){busy=data.busy===true;table.setAttribute('aria-busy',String(busy));document.body.dataset.busy=String(busy);renderActions();renderBanner();return;}
    if(data.type==='error'||data.type==='notice')announce(typeof data.message==='string'?data.message:'Action failed.',data.type==='error');
  });
  for(const [action,button] of Object.entries(buttons)){
    button.addEventListener('click',()=>{if(action==='compare'){const reason=blocker('compare',selection());if(reason){announce(reason);return;}const rect=button.getBoundingClientRect();showMenu({clientX:rect.left,clientY:rect.top+rect.height},compareEntries,button,'Compare');return;}run(action);});
    if(action==='acceptYours'||action==='acceptTheirs')for(const type of ['focus','mouseenter'])button.addEventListener(type,()=>{hintSide=action==='acceptYours'?'yours':'theirs';renderHint(selection());});
  }
  buttons.compare.setAttribute('aria-haspopup','menu');
  overflow.addEventListener('click',()=>{const rect=overflow.getBoundingClientRect();showMenu({clientX:rect.left,clientY:rect.top+rect.height},overflowEntries,overflow,'More actions');});
  toggle.addEventListener('change',()=>send({type:'setting',groupByDirectory:toggle.checked===true}));
  more.addEventListener('click',()=>{visibleCount+=200;renderRows();if(!more.hidden)more.focus();else focusRow(focusedKey);});
  const mnemonics={KeyY:'acceptYours',KeyT:'acceptTheirs',KeyM:'merge'},letters={y:'acceptYours',t:'acceptTheirs',m:'merge'};
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&menu){event.preventDefault();event.stopPropagation();closeMenu(true);return;}
    if(event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
      // The typed character decides (Dvorak, QWERTZ, AZERTY): any other ASCII key stays a workbench shortcut. Only a character Alt cannot type as itself
      // (macOS Option gives ¥, † or µ) falls back to the physical key.
      const key=String(event.key),action=key.length===1&&key.charCodeAt(0)<128?letters[key.toLowerCase()]:mnemonics[event.code];
      // The webview host forwards every keydown to the workbench whatever defaultPrevented says; only stopping it here keeps Alt+T from opening the Terminal menu (§3.16).
      if(action){event.preventDefault();event.stopPropagation();swallow=true;closeMenu(false);run(action);}
      return;
    }
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&event.key==='Enter'){
      const button=[...operationBar.children].find(node=>node.dataset.operation==='continue');if(!button)return;
      event.preventDefault();event.stopPropagation();activateOperation(button);return;
    }
    // Nothing focused yet (the tab was revealed without focus moving into it): the arrows enter the table.
    const active=document.activeElement;
    if(!event.altKey&&!event.ctrlKey&&!event.metaKey&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&(!active||active===document.body)){
      const target=byKey.has(focusedKey)?focusedKey:items.find(item=>visible(item))?.key;if(!target)return;
      event.preventDefault();focusRow(target);
    }
  });
  // The matching keyups are held back too: an Alt release the workbench sees alone would move focus to the menu bar.
  document.addEventListener('keyup',event=>{if(!swallow)return;event.stopPropagation();if(event.key==='Alt'||!event.altKey)swallow=false;});
  document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target))closeMenu(false);});
  render();send({type:'ready'});
})();
