/* Repository text and history are rendered as text, never HTML. */
(() => {
  const api = acquireVsCodeApi();
  const session = document.body.dataset.session;
  let repositoryId = '', busy = false, staged = 0, subjectLimit = 72, operation = 'idle', focusBeforeBusy;
  const element = id => document.getElementById(id);
  const rememberFocus = () => {
    const node = document.activeElement;
    if (node?.isConnected && ['message', 'history', 'clearHistory', 'amend', 'signoff', 'noVerify', 'commit', 'push'].some(id => element(id) === node)) focusBeforeBusy = { node, repositoryId };
  };
  const restoreFocus = () => {
    const saved = focusBeforeBusy; focusBeforeBusy = undefined;
    if (!saved || (typeof document.hasFocus === 'function' && !document.hasFocus())) return;
    const active = document.activeElement;
    if (active && active !== saved.node && active !== document.body && active.tagName !== 'HTML' && active.isConnected && !active.disabled) return;
    const target = saved.repositoryId === repositoryId && saved.node.isConnected && !saved.node.disabled ? saved.node : element('message');
    if (!target.disabled) target.focus();
  };
  // Conventional Commits: the type, scope and ! of the message's first line are chosen from the menu. The message stays the one source of truth: the controls read its prefix, and
  // choosing rewrites that prefix and nothing else. Only a prefix whose type is in the list is read or replaced, so a subject such as "note: this" is never taken apart.
  const conventional = element('conventional');
  let types = [];
  const typeHelp = { feat: 'a new feature', fix: 'a bug fix', docs: 'documentation only', style: 'formatting, no code change', refactor: 'neither a fix nor a feature', perf: 'a performance improvement', test: 'tests', build: 'build system or dependencies', ci: 'CI configuration', chore: 'other changes', revert: 'reverts a commit' };
  const prefixPattern = /^([a-z][a-z0-9-]*)(?:\(([^()\r\n]*)\))?(!)?:[ \t]*/;
  const firstLine = () => { const value = element('message').value, end = value.search(/\r?\n/); return { subject: end < 0 ? value : value.slice(0, end), rest: end < 0 ? '' : value.slice(end) }; };
  const readPrefix = subject => { const match = prefixPattern.exec(subject); return match && types.includes(match[1]) ? { length: match[0].length, type: match[1], scope: match[2] ?? '', breaking: Boolean(match[3]) } : undefined; };
  const showPrefix = () => {
    if (!conventional) return;
    const found = readPrefix(firstLine().subject);
    element('cc-type').value = found ? found.type : ''; element('cc-scope').value = found ? found.scope : ''; element('cc-breaking').checked = Boolean(found?.breaking);
  };
  const writePrefix = () => {
    if (busy || !repositoryId) return;
    const { subject, rest } = firstLine(), found = readPrefix(subject), type = element('cc-type').value, description = subject.slice(found ? found.length : 0).replace(/^\s+/, '');
    const scope = element('cc-scope').value.replace(/[()\r\n]/g, '').trim();
    const next = type ? `${type}${scope ? `(${scope})` : ''}${element('cc-breaking').checked ? '!' : ''}: ${description}` : description;
    element('message').value = next + rest; element('message').dispatchEvent(new Event('input'));
    element('message').setSelectionRange?.(next.length, next.length);
  };
  const showTypes = list => {
    const wanted = Array.isArray(list) ? list.filter(item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,19}$/.test(item)).slice(0, 30) : [];
    // The options are rebuilt only when the list changes, so a refresh never closes a drop-down the user has open.
    if (wanted.join(' ') !== types.join(' ')) { types = wanted; element('cc-type').replaceChildren(new Option('No type', ''), ...types.map(type => new Option(typeHelp[type] ? `${type} — ${typeHelp[type]}` : type, type))); }
    conventional.hidden = !types.length;
  };
  if (conventional) {
    element('cc-type').addEventListener('change', () => {
      writePrefix(); updateButtons();
      // Like a copied history entry, a chosen type closes the menu and returns to the message, where the description is typed next.
      const popover = document.getElementById('commit-menu'); if (popover?.open) popover.open = false;
      if (!element('message').disabled) element('message').focus();
    });
    element('cc-scope').addEventListener('change', writePrefix);
    element('cc-breaking').addEventListener('change', writePrefix);
  }
  const updateButtons = () => {
    document.body.setAttribute('aria-busy', String(busy));
    // Amend with nothing staged rewrites only the message of the last commit.
    const disabled = busy || !repositoryId || (!staged && !element('amend').checked) || !element('message').value.trim() || operation !== 'idle';
    element('commit').disabled = disabled; element('push').disabled = disabled;
    element('commit-label').textContent = busy ? 'Committing…' : 'Commit';
    for (const id of ['message', 'history', 'clearHistory', 'amend', 'signoff', 'noVerify']) element(id).disabled = busy || !repositoryId;
    if (conventional) { const off = busy || !repositoryId, untyped = !element('cc-type').value; element('cc-type').disabled = off; element('cc-scope').disabled = off || untyped; element('cc-breaking').disabled = off || untyped; }
    element('warning').textContent = element('message').value.split('\n')[0].length > subjectLimit ? `Subject exceeds ${subjectLimit} characters (warning only).` : '';
  };
  const updateOptions = () => {
    const selected = [['amend', 'Amend'], ['signoff', 'Sign-off'], ['noVerify', 'Skip hooks']].filter(([id]) => element(id).checked).map(([, label]) => label);
    element('advanced-label').textContent = ['Advanced options', ...selected].join(' · ');
    // The options live in the closed split menu, so a muted line under the button keeps the choice apparent.
    const flags = document.getElementById('option-flags');
    if (flags) { flags.textContent = selected.join(' · '); flags.hidden = !selected.length; }
  };
  for (const id of ['amend', 'signoff', 'noVerify']) element(id).addEventListener('change', () => { updateOptions(); updateButtons(); });
  // As in native Source Control: Ctrl+Enter (⌘Enter on macOS) commits from the message box, and the placeholder names the branch.
  const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
  const setPlaceholder = branch => { element('message').placeholder = `Message (${mac ? '⌘Enter' : 'Ctrl+Enter'} to commit${branch ? ` on '${branch}'` : ''})`; };
  setPlaceholder('');
  element('message').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(mac ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey) return;
    event.preventDefault(); if (!element('commit').disabled) element('commit').click();
  });
  element('message').addEventListener('input', () => {
    if (busy || !repositoryId) return;
    api.postMessage({ type: 'draft', session, repositoryId, message: element('message').value });
    showPrefix(); updateButtons();
  });
  for (const [id, push] of [['commit', false], ['push', true]]) element(id).addEventListener('click', () => {
    if (busy || element(id).disabled) return;
    element('result').textContent = '';
    rememberFocus(); busy = true; updateButtons();
    api.postMessage({ type: 'commit', session, repositoryId, message: element('message').value,
      amend: element('amend').checked, signoff: element('signoff').checked, noVerify: element('noVerify').checked, push });
  });
  element('history').addEventListener('change', () => {
    if (busy || !repositoryId) return;
    if (element('history').value) { element('message').value = element('history').value; element('message').dispatchEvent(new Event('input')); }
  });
  element('clearHistory').addEventListener('click', () => { if (!busy && repositoryId) api.postMessage({ type: 'clearHistory', session, repositoryId }); });
  // Split-button menu: Escape or a click outside closes it; it never closes on blur, so checkbox changes keep it open.
  const menu = document.getElementById('commit-menu');
  if (menu) {
    const summary = () => menu.querySelector('summary');
    menu.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { event.preventDefault(); menu.open = false; summary()?.focus(); } });
    document.addEventListener('pointerdown', event => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
    // Closing hides the focused item, so focus moves to the toggle (Commit & Push) or the message (a copied history entry).
    element('push').addEventListener('click', () => { if (!menu.open) return; const inside = menu.contains(document.activeElement); menu.open = false; if (inside) summary()?.focus(); });
    element('history').addEventListener('change', () => { if (!element('history').value || !menu.open) return; menu.open = false; if (!element('message').disabled) element('message').focus(); });
    // The short Commit view rarely fits the whole popover: cap it to the space left below (a visible warning or a taller message pushes it down) and let it scroll.
    const fit = () => { const panel = menu.querySelector('.menu'); if (menu.open && panel?.style?.setProperty) panel.style.setProperty('max-height', Math.max(96, innerHeight - panel.getBoundingClientRect().top - 8) + 'px'); };
    menu.addEventListener('toggle', fit); window.addEventListener('resize', fit); element('message').addEventListener('input', fit);
  }
  window.addEventListener('message', event => {
    const state = event.data;
    if (!state || state.session !== session) return;
    if (state.type === 'error') { busy = false; element('result').textContent = state.message; updateButtons(); restoreFocus(); return; }
    if (state.type !== 'state') return;
    const changed = repositoryId !== state.repositoryId;
    const wasBusy = busy;
    if (state.busy && !busy) rememberFocus();
    repositoryId = state.repositoryId; busy = state.busy; staged = state.staged; operation = state.operation; subjectLimit = state.subjectLimit;
    const repository = String(state.repository), name = repository.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repository;
    element('repository').textContent = name;
    element('repository').title = repository;
    element('repository').setAttribute('aria-label', repository);
    const status = busy ? 'Committing…' : !repositoryId ? 'Choose repository' : operation !== 'idle' ? `${operation} in progress` : staged ? `${staged} staged` : 'No staged changes';
    const description = busy ? status : !repositoryId ? 'Open a repository to compose a commit.' : operation !== 'idle' ? `${status} · resolve in Git Pro Conflicts` : staged ? `${staged} staged ${staged === 1 ? 'file' : 'files'} · commits the index` : 'No staged changes · stage files in Changes';
    element('staged').textContent = description;
    element('staged').title = description;
    element('staged').setAttribute('aria-label', description);
    element('staged').setAttribute('data-ready', String(!busy && !!repositoryId && staged > 0 && operation === 'idle'));
    setPlaceholder(typeof state.branch === 'string' ? state.branch : '');
    if (conventional) showTypes(state.conventionalTypes);
    if (changed || document.activeElement !== element('message') || busy || wasBusy) element('message').value = state.message;
    showPrefix();
    if (changed) { for (const id of ['amend', 'signoff', 'noVerify']) element(id).checked = false; element('result').textContent = ''; }
    element('history').replaceChildren(new Option('Choose previous message…', ''), ...state.history.map(message => new Option(message.split('\n')[0], message)));
    updateOptions(); updateButtons();
    if (!busy) restoreFocus();
  });
  updateButtons(); api.postMessage({ type: 'ready', session });
})();
