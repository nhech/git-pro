(() => {
  const vscode=acquireVsCodeApi(),rows=document.getElementById('rows'),notice=document.getElementById('notice'),selectionBar=document.getElementById('selection-actions'),selectionCount=document.getElementById('selection-count'),more=document.getElementById('more');
  const selected=new Set(),collapsed=new Set();let session=document.body.dataset.session||'',items=[],rowByKey=new Map(),busy=false,menu,focusedKey='',anchorKey='',visibleCount=200,stateIdentity='';
  const send=(message)=>session&&vscode.postMessage({...message,session});
  const publishSelection=()=>send({type:'select',keys:[...selected]});
  const branch=row=>row.kind==='group'||row.kind==='folder';
  const stateClass=status=>({'Added':'added','Untracked':'untracked','Modified':'modified','Deleted':'deleted','Renamed':'renamed','Copied':'copied','Type changed':'type','Conflict':'conflict'}[status]||'other');
  const iconFor=row=>row.kind==='group'?(row.group==='staged'?'✓':row.group==='conflicts'?'!':row.group==='untracked'?'+':'◉'):row.kind==='folder'?'▰':row.status==='Deleted'?'−':row.status==='Renamed'?'↗':row.status==='Copied'?'⧉':row.status==='Type changed'?'◇':row.status==='Conflict'||row.group==='conflicts'?'!':row.status==='Added'||row.status==='Untracked'?'+':'•';
  const visible=row=>{let parent=row.parent;while(parent){if(collapsed.has(parent))return false;parent=rowByKey.get(parent)?.parent;}return true;};
  const shownRows=()=>items.filter(visible).slice(0,visibleCount);
  const action=(name,key,keys)=>{if(!busy)send({type:'action',action:name,...(key?{key}:{}),...(keys?{keys}:{})});};
  const selectionNodes=()=>[...selected].map(key=>rowByKey.get(key)).filter(Boolean);
  const canMutate=(name,nodes)=>{
    const compatible=nodes.length>0&&(nodes.every(row=>row.kind==='file')||nodes.length===1&&nodes[0].kind==='folder');
    return compatible&&nodes.every(row=>name==='stage'?['working','untracked'].includes(row.group):name==='unstage'?row.group==='staged':row.group==='working');
  };
  const contextActions=row=>{
    if(row.kind==='group')return row.group==='staged'?[['unstageAll','Unstage Staged Changes']]:['working','untracked'].includes(row.group)?[['stageAll',`Stage ${row.label}`]]:[];
    if(row.kind==='folder')return row.group==='staged'?[['unstage','Unstage Folder']]:row.group==='working'?[['stage','Stage Folder'],['discard','Discard Folder']]:row.group==='untracked'?[['stage','Stage Folder']]:[];
    if(row.kind!=='file')return[];
    const result=row.group==='conflicts'?[['resolve','Resolve Conflict']]:[['diff','Diff']];if(row.group==='staged')result.push(['unstage','Unstage']);if(['working','untracked'].includes(row.group))result.push(['stage','Stage']);result.push(['history','File History'],['copyPath','Copy Relative Path']);if(row.group==='working')result.push(['discard','Discard']);return result;
  };
  // Inline row actions, as in native Source Control: shown on hover, focus and selection. Each one is also in the context menu.
  const inlineActions=row=>{
    if(row.kind==='group')return row.group==='staged'?[['unstageAll','Unstage All Changes']]:['working','untracked'].includes(row.group)?[['stageAll',`Stage All ${row.label}`]]:[];
    if(row.kind==='folder')return row.group==='staged'?[['unstage','Unstage Folder']]:row.group==='working'?[['discard','Discard Folder'],['stage','Stage Folder']]:row.group==='untracked'?[['stage','Stage Folder']]:[];
    if(row.kind!=='file')return[];
    const deleted=stateClass(row.status)==='deleted',result=[];
    if(row.group==='conflicts')return[...(deleted?[]:[['open','Open File']]),['resolve','Resolve Conflict']];
    if(row.group!=='untracked')result.push(['diff','Open Changes']);
    if(!deleted)result.push(['open','Open File']);
    if(row.group==='working')result.push(['discard','Discard Changes']);
    result.push(row.group==='staged'?['unstage','Unstage Changes']:['stage','Stage Changes']);return result;
  };
  // File-type glyphs in the spirit of the Seti icon theme. Static text and vectors only; the type comes from the name's extension.
  const fileType=name=>{
    const lower=name.toLowerCase(),base=lower.slice(lower.lastIndexOf('/')+1),extension=base.includes('.')?base.slice(base.lastIndexOf('.')+1):'';
    if(/^\.git(?:ignore|attributes|modules|keep)?$/.test(base))return'git';
    if(base==='readme.md'||base==='readme')return'info';if(base==='changelog.md'||base==='history.md')return'history';
    if(/(?:^|[.-])lock$|^package-lock\.json$|\.lock$/.test(base))return'lock';
    if(/^(?:dockerfile|makefile|\.env.*|\.editorconfig|\.npmrc|\.prettierrc.*|\.eslintrc.*)$/.test(base))return'config';
    if(/^(?:license|licence|copying)(?:\.(?:md|txt))?$/.test(base))return'text';
    return{ts:'ts',mts:'ts',cts:'ts',tsx:'tsx',js:'js',mjs:'js',cjs:'js',jsx:'jsx',json:'json',jsonc:'json',md:'md',markdown:'md',mdx:'md',css:'css',scss:'scss',sass:'scss',less:'css',html:'html',htm:'html',xml:'xml',vue:'vue',svelte:'svelte',
      py:'py',go:'go',rs:'rs',java:'java',kt:'kt',cs:'cs',c:'c',h:'h',cpp:'cpp',cc:'cpp',hpp:'cpp',php:'php',rb:'rb',swift:'swift',dart:'dart',sh:'sh',bash:'sh',zsh:'sh',ps1:'ps',
      yml:'yaml',yaml:'yaml',toml:'config',ini:'config',cfg:'config',conf:'config',sql:'sql',png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',ico:'image',bmp:'image',svg:'svg',txt:'text',log:'text',csv:'text',pdf:'text'}[extension]||'file';
  };
  const typeLabels={ts:'TS',tsx:'TSX',js:'JS',jsx:'JSX',json:'{}',md:'M↓',css:'#',scss:'#',html:'<>',xml:'<>',svg:'<>',vue:'V',svelte:'S',py:'PY',go:'GO',rs:'RS',java:'J',kt:'K',cs:'C#',c:'C',h:'H',cpp:'C+',php:'PHP',rb:'RB',swift:'SW',dart:'DT',sh:'$_',ps:'>_',yaml:'YML',sql:'SQL'};
  const typeShapes={
    file:'M6 3h8l4 4v14H6zM14 3v4h4',text:'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15h6M9 18h4',
    image:'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',git:'M12 3l9 9-9 9-9-9zM9.5 9.5l5 5M12 12v4',
    config:'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8',
    lock:'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2',info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
    history:'M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4M12 7v5l3 2',folder:'M3 6h6l2 2h10v11H3z'
  };
  const fileGlyph=type=>{
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
    const label=typeLabels[type];
    if(label){const glyph=document.createElementNS(ns,'text');glyph.setAttribute('x','12');glyph.setAttribute('y','16.5');glyph.setAttribute('text-anchor','middle');glyph.setAttribute('font-size',label.length>2?'10':'13');glyph.setAttribute('font-weight','700');glyph.setAttribute('fill','currentColor');glyph.textContent=label;svg.append(glyph);}
    else{const shape=document.createElementNS(ns,'path');shape.setAttribute('d',typeShapes[type]||typeShapes.file);shape.setAttribute('fill','none');shape.setAttribute('stroke','currentColor');shape.setAttribute('stroke-width','1.7');shape.setAttribute('stroke-linecap','round');shape.setAttribute('stroke-linejoin','round');svg.append(shape);}
    return svg;
  };
  // Context-menu icons: static codicon vectors (verbatim from @vscode/codicons src/icons); repository paths are always rendered as plain text.
  const menuIcon=name=>{
    const paths={
      diff:['M9.14645 5.85355C9.34171 6.04882 9.65829 6.04882 9.85355 5.85355C10.0488 5.65829 10.0488 5.34171 9.85355 5.14645L8.70711 4H10.5C11.3284 4 12 4.67157 12 5.5V10.05C10.8589 10.2816 10 11.2905 10 12.5C10 13.8807 11.1193 15 12.5 15C13.8807 15 15 13.8807 15 12.5C15 11.2905 14.1411 10.2816 13 10.05V5.5C13 4.11929 11.8807 3 10.5 3H8.70711L9.85355 1.85355C10.0488 1.65829 10.0488 1.34171 9.85355 1.14645C9.65829 0.951184 9.34171 0.951184 9.14645 1.14645L7.14645 3.14645C6.95118 3.34171 6.95118 3.65829 7.14645 3.85355L9.14645 5.85355ZM14 12.5C14 13.3284 13.3284 14 12.5 14C11.6716 14 11 13.3284 11 12.5C11 11.6716 11.6716 11 12.5 11C13.3284 11 14 11.6716 14 12.5ZM6 3.5C6 4.70948 5.14112 5.71836 4 5.94999V10.5C4 11.3284 4.67157 12 5.5 12H7.29289L6.14645 10.8536C5.95118 10.6583 5.95118 10.3417 6.14645 10.1464C6.34171 9.95118 6.65829 9.95118 6.85355 10.1464L8.85355 12.1464C9.04882 12.3417 9.04882 12.6583 8.85355 12.8536L6.85355 14.8536C6.65829 15.0488 6.34171 15.0488 6.14645 14.8536C5.95118 14.6583 5.95118 14.3417 6.14645 14.1464L7.29289 13H5.5C4.11929 13 3 11.8807 3 10.5V5.94999C1.85888 5.71836 1 4.70948 1 3.5C1 2.11929 2.11929 1 3.5 1C4.88071 1 6 2.11929 6 3.5ZM5 3.5C5 2.67157 4.32843 2 3.5 2C2.67157 2 2 2.67157 2 3.5C2 4.32843 2.67157 5 3.5 5C4.32843 5 5 4.32843 5 3.5Z'],
      stage:['M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z'],
      unstage:['M1 7.5C1 7.22386 1.22386 7 1.5 7H13.5C13.7761 7 14 7.22386 14 7.5C14 7.77614 13.7761 8 13.5 8H1.5C1.22386 8 1 7.77614 1 7.5Z'],
      history:['M7.99909 3C10.7605 3 12.9991 5.23858 12.9991 8C12.9991 10.7614 10.7605 13 7.99909 13C5.39117 13 3.2491 11.003 3.0195 8.45512C2.99471 8.1801 2.75167 7.97723 2.47664 8.00202C2.20161 8.0268 1.99875 8.26985 2.02353 8.54488C2.29916 11.6035 4.86898 14 7.99909 14C11.3128 14 13.9991 11.3137 13.9991 8C13.9991 4.68629 11.3128 2 7.99909 2C6.20656 2 4.59815 2.78613 3.49909 4.03138V2.5C3.49909 2.22386 3.27524 2 2.99909 2C2.72295 2 2.49909 2.22386 2.49909 2.5V5.5C2.49909 5.77614 2.72295 6 2.99909 6H3.08812C3.09498 6.00014 3.10184 6.00014 3.10868 6H5.99909C6.27524 6 6.49909 5.77614 6.49909 5.5C6.49909 5.22386 6.27524 5 5.99909 5H3.99863C4.91128 3.78495 6.36382 3 7.99909 3ZM7.99909 5.5C7.99909 5.22386 7.77524 5 7.49909 5C7.22295 5 6.99909 5.22386 6.99909 5.5V8.5C6.99909 8.77614 7.22295 9 7.49909 9H9.49909C9.77524 9 9.99909 8.77614 9.99909 8.5C9.99909 8.22386 9.77524 8 9.49909 8H7.99909V5.5Z'],
      copyPath:['M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z'],
      discard:['M3.00098 2.5C3.00098 2.22386 3.22483 2 3.50098 2C3.77712 2 4.00098 2.22386 4.00098 2.5V6.34262L7.17202 3.17157C8.73412 1.60948 11.2668 1.60948 12.8289 3.17157C14.391 4.73367 14.391 7.26633 12.8289 8.82843L7.80375 13.8536C7.60849 14.0488 7.2919 14.0488 7.09664 13.8536C6.90138 13.6583 6.90138 13.3417 7.09664 13.1464L12.1218 8.12132C13.2933 6.94975 13.2933 5.05025 12.1218 3.87868C10.9502 2.70711 9.0507 2.70711 7.87913 3.87868L4.75781 7H8.50098C8.77712 7 9.00098 7.22386 9.00098 7.5C9.00098 7.77614 8.77712 8 8.50098 8H3.60098C3.26961 8 3.00098 7.73137 3.00098 7.4V2.5Z'],
      resolve:['M11.5 5.99998C10.9265 6.00006 10.3704 6.19736 9.92505 6.55877C9.47971 6.92018 9.17217 7.42373 9.05402 7.98498C7.17202 7.85998 5.46602 6.96298 5.08102 5.93098C5.67998 5.78724 6.20478 5.42744 6.55479 4.92058C6.9048 4.41373 7.05538 3.7955 6.97763 3.18446C6.89989 2.57343 6.5993 2.0126 6.13352 1.60954C5.66774 1.20648 5.06956 0.989562 4.45369 1.00039C3.83782 1.01121 3.24763 1.24902 2.7963 1.6682C2.34497 2.08738 2.06428 2.65842 2.00806 3.27181C1.95184 3.8852 2.12404 4.49776 2.49165 4.992C2.85925 5.48624 3.39638 5.82737 4.00002 5.94998V10.05C3.393 10.1739 2.85361 10.5188 2.48642 11.0178C2.11923 11.5168 1.95041 12.1343 2.01268 12.7507C2.07495 13.3671 2.36387 13.9385 2.82344 14.3539C3.28301 14.7694 3.88048 14.9995 4.50002 14.9995C5.11956 14.9995 5.71703 14.7694 6.1766 14.3539C6.63616 13.9385 6.92509 13.3671 6.98736 12.7507C7.04963 12.1343 6.88081 11.5168 6.51362 11.0178C6.14643 10.5188 5.60704 10.1739 5.00002 10.05V7.46598C6.15462 8.38805 7.57188 8.92022 9.04802 8.98598C9.1401 9.4506 9.36227 9.8795 9.68867 10.2227C10.0151 10.566 10.4323 10.8094 10.8917 10.9248C11.3511 11.0401 11.8338 11.0225 12.2836 10.8741C12.7334 10.7257 13.1318 10.4526 13.4324 10.0865C13.733 9.72047 13.9234 9.27655 13.9815 8.80647C14.0395 8.33639 13.9629 7.85948 13.7604 7.43128C13.5579 7.00308 13.238 6.64122 12.8378 6.38782C12.4376 6.13442 11.9737 5.99992 11.5 5.99998ZM3.00002 3.49998C3.00002 3.20331 3.08799 2.9133 3.25282 2.66662C3.41764 2.41995 3.65191 2.22769 3.92599 2.11416C4.20008 2.00063 4.50168 1.97092 4.79265 2.0288C5.08363 2.08668 5.3509 2.22954 5.56068 2.43932C5.77046 2.6491 5.91332 2.91637 5.9712 3.20734C6.02908 3.49831 5.99937 3.79991 5.88584 4.074C5.77231 4.34809 5.58005 4.58236 5.33337 4.74718C5.0867 4.912 4.79669 4.99998 4.50002 4.99998C4.10219 4.99998 3.72066 4.84194 3.43936 4.56064C3.15805 4.27933 3.00002 3.8978 3.00002 3.49998ZM6.00002 12.5C6.00002 12.7966 5.91205 13.0867 5.74722 13.3333C5.5824 13.58 5.34813 13.7723 5.07404 13.8858C4.79996 13.9993 4.49836 14.029 4.20738 13.9712C3.91641 13.9133 3.64914 13.7704 3.43936 13.5606C3.22958 13.3509 3.08672 13.0836 3.02884 12.7926C2.97096 12.5016 3.00067 12.2 3.1142 11.926C3.22773 11.6519 3.41999 11.4176 3.66666 11.2528C3.91334 11.088 4.20335 11 4.50002 11C4.89784 11 5.27938 11.158 5.56068 11.4393C5.84198 11.7206 6.00002 12.1022 6.00002 12.5ZM11.5 9.99998C11.2033 9.99998 10.9133 9.91201 10.6667 9.74718C10.42 9.58236 10.2277 9.34809 10.1142 9.074C10.0007 8.79991 9.97096 8.49831 10.0288 8.20734C10.0867 7.91637 10.2296 7.6491 10.4394 7.43932C10.6491 7.22954 10.9164 7.08668 11.2074 7.0288C11.4984 6.97092 11.8 7.00063 12.074 7.11416C12.3481 7.22769 12.5824 7.41995 12.7472 7.66662C12.912 7.9133 13 8.20331 13 8.49998C13 8.8978 12.842 9.27933 12.5607 9.56064C12.2794 9.84194 11.8978 9.99998 11.5 9.99998Z']
    },kind=name==='stageAll'?'stage':name==='unstageAll'?'unstage':name;
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('class','menu-icon');icon.setAttribute('viewBox','0 0 16 16');icon.setAttribute('fill','currentColor');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');
    for(const value of paths[kind]||[]){const segment=document.createElementNS('http://www.w3.org/2000/svg','path');segment.setAttribute('d',value);icon.append(segment);}return icon;
  };
  // Inline row actions use codicons, as native Source Control does.
  const actionGlyph=id=>{const glyph=document.createElement('span');glyph.className='codicon codicon-'+({diff:'git-compare',open:'go-to-file',discard:'discard',stage:'add',stageAll:'add',unstage:'remove',unstageAll:'remove',resolve:'git-merge'})[id];glyph.setAttribute('aria-hidden','true');return glyph;};
  const focusRow=key=>{const target=rows.querySelector(`[data-key="${key}"]`);if(!target)return;focusedKey=key;for(const node of rows.querySelectorAll('[data-key]'))node.tabIndex=node===target?0:-1;target.focus();};
  const closeMenu=restore=>{if(menu){menu.remove();menu=undefined;}if(restore)focusRow(focusedKey);};
  const showMenu=(row,event)=>{
    closeMenu(false);if(!selected.has(row.key)){selected.clear();if(row.kind!=='group')selected.add(row.key);publishSelection();renderSelection();}
    focusedKey=row.key;menu=document.createElement('div');menu.className='context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',`${row.label} actions`);
    for(const [id,label] of contextActions(row)){
      if(id==='discard'){const separator=document.createElement('div');separator.className='menu-separator';separator.setAttribute('role','separator');separator.setAttribute('aria-orientation','horizontal');menu.append(separator);}
      const bulk=['stage','unstage','discard'].includes(id),chosen=bulk&&selected.has(row.key)?[...selected]:[row.key];
      const button=document.createElement('button');button.type='button';button.dataset.menuAction=id;button.setAttribute('role','menuitem');const text=document.createElement('span');text.className='menu-label';text.textContent=bulk&&chosen.length>1?`${label} ${chosen.length} Selected`:label;button.append(menuIcon(id),text);
      button.disabled=busy||bulk&&!canMutate(id,chosen.map(key=>rowByKey.get(key)).filter(Boolean));
      button.addEventListener('click',()=>{if(button.disabled)return;closeMenu(true);action(id,row.key,chosen);});menu.append(button);
    }
    if(!menu.childElementCount){menu=undefined;return;}
    menu.addEventListener('keydown',event=>{
      const buttons=[...menu.querySelectorAll('button')].filter(button=>!button.disabled),index=buttons.indexOf(document.activeElement);let next;
      if(event.key==='ArrowDown')next=buttons[(index+1)%buttons.length];else if(event.key==='ArrowUp')next=buttons[(index-1+buttons.length)%buttons.length];else if(event.key==='Home')next=buttons[0];else if(event.key==='End')next=buttons.at(-1);else if(event.key==='Tab'){closeMenu(true);event.preventDefault();return;}else return;
      event.preventDefault();next?.focus();
    });
    document.body.append(menu);const rect=menu.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(event.clientX,innerWidth-rect.width-4))}px`;menu.style.top=`${Math.max(4,Math.min(event.clientY,innerHeight-rect.height-4))}px`;[...menu.querySelectorAll('button')].find(button=>!button.disabled)?.focus();
  };
  function renderSelection(){
    const nodes=selectionNodes();
    selectionBar.hidden=nodes.length===0;selectionCount.textContent=nodes.length?`${nodes.length} selected`:'';
    for(const name of ['stage','unstage','discard'])selectionBar.querySelector(`[data-action="${name}"]`).disabled=busy||!canMutate(name,nodes);
    for(const item of rows.querySelectorAll('[data-key]')){item.setAttribute('aria-selected',String(selected.has(item.dataset.key)));item.tabIndex=item.dataset.key===focusedKey?0:-1;}
  }
  const selectRow=(row,event)=>{
    if(row.kind==='group')return;
    if(event.ctrlKey||event.metaKey){if(selected.has(row.key))selected.delete(row.key);else if(selected.size<100)selected.add(row.key);else notice.textContent='Select up to 100 entries at a time.';}
    else if(event.shiftKey&&anchorKey){const shown=shownRows().filter(item=>item.kind==='file'),from=shown.findIndex(item=>item.key===anchorKey),to=shown.findIndex(item=>item.key===row.key);selected.clear();if(from>=0&&to>=0)for(const item of shown.slice(Math.min(from,to),Math.max(from,to)+1).slice(0,100))selected.add(item.key);else selected.add(row.key);}
    else{selected.clear();selected.add(row.key);}if(!event.shiftKey)anchorKey=row.key;focusedKey=row.key;publishSelection();renderSelection();
  };
  function render(){
    const restoreTreeFocus=rows.contains(document.activeElement),scroll=rows.scrollTop;rows.replaceChildren();rowByKey=new Map(items.map(row=>[row.key,row]));
    const pageRows=shownRows(),focusable=pageRows.filter(row=>row.kind!=='message');if(!focusable.some(row=>row.key===focusedKey))focusedKey=focusable[0]?.key||'';
    for(const row of pageRows){
      if(row.kind==='message'){const message=document.createElement('div');message.className='empty';message.textContent=row.label;rows.append(message);continue;}
      const node=document.createElement('div');node.className=`entry depth-${Math.min(row.depth,8)} ${row.kind}${row.group?` ${row.group}`:''}${row.status?` state-${stateClass(row.status)}`:''}`;node.dataset.key=row.key;node.setAttribute('role','treeitem');node.tabIndex=focusedKey===row.key?0:-1;
      node.setAttribute('aria-level',String(row.depth+1));node.setAttribute('aria-selected',String(selected.has(row.key)));if(branch(row))node.setAttribute('aria-expanded',String(!collapsed.has(row.key)));
      node.setAttribute('aria-label',row.kind==='file'?`${row.label}, ${row.status||row.group}`:row.kind==='group'?`${row.label}, ${row.count} changes`:`${row.label}, ${row.group} folder`);node.title=row.label;
      const main=document.createElement('span');main.className='entry-main';
      if(branch(row)){const disclosure=document.createElement('span');disclosure.className='disclosure';disclosure.setAttribute('aria-hidden','true');disclosure.textContent=collapsed.has(row.key)?'›':'⌄';main.append(disclosure);}
      const marker=document.createElement('span');marker.className='marker';marker.setAttribute('aria-hidden','true');marker.textContent=iconFor(row);
      // Files and folders show their type; the status glyph stays as the marker's text for assistive and plain-text readers.
      if(row.kind==='file'||row.kind==='folder'){const type=row.kind==='folder'?'folder':fileType(row.label);marker.dataset.type=type;marker.append(fileGlyph(type));}
      const name=document.createElement('span');name.className='name';
      // The text stays the exact path; CSS shows the file name first and its directory dimmed, as native Source Control does.
      const slash=row.kind==='file'?row.label.lastIndexOf('/'):-1;
      if(slash>0){const directory=document.createElement('span');directory.className='dir';directory.textContent=row.label.slice(0,slash);const separator=document.createElement('span');separator.className='sep';separator.textContent='/';const base=document.createElement('span');base.className='base';base.textContent=row.label.slice(slash+1);name.append(directory,separator,base);}
      else name.textContent=row.label;
      main.append(marker,name);node.append(main);
      if(row.kind==='group'){const count=document.createElement('span');count.className='count';count.textContent=String(row.count??0);node.append(count);}else if(row.kind==='file'){const badge=document.createElement('span');badge.className='status';badge.textContent=row.status||'Changed';badge.title=row.status||'Changed';
        // The word stays the text (and part of the row's label); CSS draws this one-letter decoration.
        badge.dataset.letter=({'Added':'A','Untracked':'U','Modified':'M','Deleted':'D','Renamed':'R','Copied':'C','Type changed':'T','Conflict':'!'})[row.status]||'•';node.append(badge);}
      else{const badge=document.createElement('span');badge.className='status folder-label';badge.textContent='Folder';badge.dataset.letter='';node.append(badge);}
      // Appended after the status so the row's semantic children keep their order; CSS places the bar before the status.
      const inline=inlineActions(row);
      if(inline.length){const bar=document.createElement('span');bar.className='row-actions';bar.setAttribute('aria-hidden','true');
        for(const [id,label] of inline){const button=document.createElement('button');button.type='button';button.tabIndex=-1;button.dataset.inlineAction=id;button.title=label;button.setAttribute('aria-label',label);button.append(actionGlyph(id));
          for(const type of ['mousedown','dblclick'])button.addEventListener(type,event=>event.stopPropagation());
          button.addEventListener('click',event=>{event.stopPropagation();event.preventDefault();closeMenu(false);if(busy)return;
            if(id==='stageAll'||id==='unstageAll'){action(id,row.key,[row.key]);return;}
            const bulk=['stage','unstage','discard'].includes(id),chosen=bulk&&selected.has(row.key)&&selected.size>1?[...selected]:[row.key];
            if(bulk&&!canMutate(id,chosen.map(key=>rowByKey.get(key)).filter(Boolean)))return;action(id,row.key,chosen);});
          bar.append(button);}
        node.append(bar);}
      node.addEventListener('focus',()=>{focusedKey=row.key;for(const item of rows.querySelectorAll('[data-key]'))item.tabIndex=item===node?0:-1;});
      node.addEventListener('click',event=>{
        closeMenu(false);focusRow(row.key);if(row.kind==='group'||row.kind==='folder'&&event.target?.className==='disclosure'){if(collapsed.has(row.key))collapsed.delete(row.key);else collapsed.add(row.key);render();return;}
        selectRow(row,event);
      });
      node.addEventListener('dblclick',()=>{if(row.kind==='file')action('diff',row.key);else if(row.kind==='folder'){if(collapsed.has(row.key))collapsed.delete(row.key);else collapsed.add(row.key);render();}});
      node.addEventListener('contextmenu',event=>{event.preventDefault();showMenu(row,event);});
      node.addEventListener('keydown',event=>{
        if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();const rect=node.getBoundingClientRect();showMenu(row,{clientX:rect.left+24,clientY:rect.top+20});return;}
        if(event.key===' '&&row.kind!=='group'){event.preventDefault();selectRow(row,{ctrlKey:true});return;}
        if(event.key==='Enter'||event.key===' '&&row.kind==='group'){event.preventDefault();if(row.kind==='file')action('diff',row.key);else if(branch(row)){if(collapsed.has(row.key))collapsed.delete(row.key);else collapsed.add(row.key);render();}return;}
        const shown=shownRows().filter(item=>item.kind!=='message'),index=shown.findIndex(item=>item.key===row.key);let next;
        if(event.key==='ArrowDown')next=shown[index+1];else if(event.key==='ArrowUp')next=shown[index-1];else if(event.key==='Home')next=shown[0];else if(event.key==='End')next=shown.at(-1);
        else if(event.key==='ArrowRight'&&branch(row)){if(collapsed.has(row.key)){collapsed.delete(row.key);render();}else next=shown.find(item=>item.parent===row.key);}
        else if(event.key==='ArrowLeft'){if(branch(row)&&!collapsed.has(row.key)){collapsed.add(row.key);render();}else next=shown.find(item=>item.key===row.parent);}else return;
        event.preventDefault();if(next){focusRow(next.key);if(event.shiftKey)selectRow(next,{shiftKey:true});}
      });rows.append(node);
    }
    rows.scrollTop=scroll;const remaining=items.filter(visible).length-pageRows.length;more.hidden=remaining<=0;more.textContent=`Show ${Math.min(200,remaining)} more changes (${remaining} remaining)`;if(restoreTreeFocus)focusRow(focusedKey);renderSelection();
  }
  window.addEventListener('message',event=>{
    const data=event.data;if(!data||typeof data!=='object'||data.session!==session)return;
    if(data.type==='state'){
      const nextItems=Array.isArray(data.rows)?data.rows:[],nextIdentity=JSON.stringify([data.repository,data.total,data.message,nextItems]);
      if(nextIdentity===stateIdentity)return;stateIdentity=nextIdentity;
      const restore=Boolean(menu);closeMenu(false);items=nextItems;rowByKey=new Map(items.map(row=>[row.key,row]));for(const key of selected)if(!rowByKey.has(key))selected.delete(key);for(const key of collapsed)if(!rowByKey.has(key))collapsed.delete(key);publishSelection();notice.textContent=typeof data.message==='string'?data.message:'';notice.classList.remove('error');rows.setAttribute('aria-label',data.repository?`${data.repository} changes`:'Repository changes');render();if(restore)focusRow(focusedKey);return;
    }
    if(data.type==='busy'){busy=data.busy===true;rows.dataset.busy=String(busy);const restore=Boolean(menu);closeMenu(restore);renderSelection();return;}if(data.type==='error'){notice.textContent=typeof data.message==='string'?data.message:'Action failed.';notice.classList.add('error');}
  });
  document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;closeMenu(false);const name=button.dataset.action;if(['refresh','stageAll','unstageAll'].includes(name))action(name);else if(canMutate(name,selectionNodes()))action(name,undefined,[...selected]);});
  more.addEventListener('click',()=>{visibleCount+=200;render();if(!more.hidden)more.focus();else focusRow(focusedKey);});
  document.addEventListener('pointerdown',event=>{if(menu&&!menu.contains(event.target))closeMenu(false);});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu){closeMenu(true);event.preventDefault();}});
  send({type:'ready'});
})();
