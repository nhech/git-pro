(() => {
  // Git Pro Compare tab. Every repository-derived string is set with textContent; the host resolves indexes and loaded OIDs, never paths or refs from here.
  const api = acquireVsCodeApi(), session = document.body.dataset.session || '';
  const byId = id => document.getElementById(id);
  const title = byId('title'), summary = byId('summary'), moved = byId('moved'), movedText = byId('moved-text'), movedRefresh = byId('moved-refresh'), status = byId('status');
  const workspace = byId('workspace'), commitsPane = byId('commits'), modeGroup = byId('files-mode'), layout = byId('layout'), heading = byId('files-heading'), legend = byId('legend');
  const tree = byId('file-rows'), filesEmpty = byId('files-empty'), pager = byId('files-pager'), footer = byId('files-footer'), worktreeBar = byId('worktree-actions'), getButton = byId('get-from-branch'), selectionHint = byId('selection-hint');
  const swapButton = byId('swap'), refreshButton = byId('refresh'), openAll = byId('open-all');
  const saved = (() => { try { const value = api.getState?.(); return value && typeof value === 'object' ? value : {}; } catch { return {}; } })();
  // The tab keeps no renderer while hidden (a diff opened over it): the Get from Branch selection and the focused row come back with the same captured list.
  const own = saved.session === session && Number.isSafeInteger(saved.revision), isIndex = value => Number.isSafeInteger(value) && value >= 0;
  let state, busy = false, flat = saved.flat === true, revision = own ? saved.revision : undefined, anchor = own && isIndex(saved.anchor) ? saved.anchor : undefined;
  let lastTreeKey = own && typeof saved.focusKey === 'string' ? saved.focusKey.slice(0, 200) : '', restoreKey, pendingFocus = lastTreeKey || undefined;
  const chosen = new Set(own && Array.isArray(saved.chosen) ? saved.chosen.filter(isIndex).slice(0, 100) : []), collapsed = new Set(), focusables = new Map();
  let treeRows = [];
  const fileItems = new Map();
  const send = message => { if (session) api.postMessage({ ...message, session }); };
  const act = (type, extra) => {
    if (busy || !state || state.loading || typeof state.revision !== 'number') return;
    status.textContent = ''; status.className = ''; send({ type, revision: state.revision, ...(extra || {}) });
  };
  const node = (tag, className, value) => { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) element.textContent = value; return element; };
  const glyph = name => { const element = node('span', `codicon codicon-${name}`); element.setAttribute('aria-hidden', 'true'); return element; };
  const button = (className, label, key) => { const element = node('button', className, label); element.type = 'button'; if (key) keyed(element, key); return element; };
  const keyed = (element, key) => { element.dataset.focusKey = key; focusables.set(key, element); return element; };
  const short = value => typeof value === 'string' ? value.slice(0, 8) : '';
  const count = (value, word) => `${Number(value || 0).toLocaleString()} ${word}${value === 1 ? '' : 's'}`;
  const remember = () => {
    try { api.setState?.({ flat, session, ...(revision === undefined ? {} : { revision }), chosen: [...chosen], ...(anchor === undefined ? {} : { anchor }), ...(lastTreeKey ? { focusKey: lastTreeKey } : {}) }); }
    catch { /* Webview state is a per-viewer convenience only. */ }
  };
  const relative = timestamp => {
    const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp)), day = 86400;
    if (seconds < 60) return 'just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`; if (seconds < day) return `${Math.floor(seconds / 3600)} h ago`;
    if (seconds < day * 30) return `${Math.floor(seconds / day)} d ago`; if (seconds < day * 365) return `${Math.floor(seconds / (day * 30))} mo ago`; return `${Math.floor(seconds / (day * 365))} y ago`;
  };
  const statusWords = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', X: 'Unknown', B: 'Broken pair' };
  const presenceText = item => item.presence === 'branch' ? `Only in ${state.left.name}` : item.presence === 'worktree' ? 'Only in the working tree' : item.presence === 'both' ? 'Changed in both' : '';
  const rove = (rows, target) => { for (const row of rows) row.tabIndex = row === target ? 0 : -1; target.focus(); };

  // Right-click menus are VS Code's own (contributes.menus["webview/context"]): an element names itself with data-vscode-context, the host re-checks it against what this tab showed.
  document.body.setAttribute?.('data-vscode-context', JSON.stringify({ preventDefaultContextMenuItems: true }));
  const tag = (element, values) => { element.setAttribute('data-vscode-context', JSON.stringify({ preventDefaultContextMenuItems: true, session, revision: state?.revision, ...values })); return element; };

  const refChip = side => {
    const chip = node('span', side.current ? 'ref current' : 'ref'); chip.title = side.oid ? `${side.name} · ${side.oid}` : side.name;
    if (side.current) { const dot = node('span', 'current-dot', '●'); dot.setAttribute('aria-hidden', 'true'); chip.append(dot); }
    chip.append(node('span', 'ref-name', side.name)); if (side.current) chip.append(node('span', 'current-badge', '(current)'));
    return chip;
  };
  const renderHeader = () => {
    title.replaceChildren();
    if (!state?.left) { title.textContent = 'Compare'; return; }
    const words = value => node('span', 'title-words', value);
    if (state.mode === 'worktree') {
      const on = state.head ? ` on ${state.head}` : '';
      if (state.swapped) title.append(words(`The working tree${on} compared with files in `), refChip(state.left));
      else title.append(words('Files in '), refChip(state.left), words(` compared with the working tree${on}`));
    } else if (state.right) title.append(words('Compare '), refChip(state.left), words(' with '), refChip(state.right));
  };
  const renderSummary = () => {
    summary.textContent = ''; moved.hidden = true;
    if (!state?.left) return;
    if (state.mode === 'worktree') summary.textContent = `${state.left.name} ${short(state.left.oid)} · Tracked files, staged and unstaged · Untracked files are not compared`;
    else if (state.right && state.left.oid === state.right.oid) summary.textContent = `${state.left.name} and ${state.right.name} point to the same commit.`;
    else if (state.right && state.sides) summary.textContent = [state.fork ? state.fork.oid ? `Fork point ${short(state.fork.oid)}${state.fork.multiple ? ' (one of several merge bases)' : ''}` : state.fork.shallow ? 'Fork point unknown (shallow clone)' : 'No common ancestor' : '',
      `${state.left.name} +${state.sides.leftOnly.count.toLocaleString()}`, `${state.right.name} +${state.sides.rightOnly.count.toLocaleString()}`].filter(Boolean).join(' · ');
    // A moved ref can be re-pinned by Refresh; a ref that no longer resolves, or a closed repository, cannot.
    const moves = Array.isArray(state.moved) ? state.moved : [], gone = Array.isArray(state.gone) ? state.gone : [];
    const notes = state.expired ? ['This repository is no longer open in Git Pro, so this comparison cannot be refreshed. Open the repository again to continue.'] : [
      ...(moves.length ? [`${moves.join(', ')} ${moves.length === 1 ? 'has' : 'have'} moved since this comparison.`] : []),
      ...(gone.length ? [`${gone.join(', ')} no longer ${gone.length === 1 ? 'resolves to a commit' : 'resolve to commits'}; the comparison keeps its pinned commits.`] : [])];
    if (notes.length) { moved.hidden = false; movedText.textContent = notes.join(' '); }
    movedRefresh.hidden = Boolean(state.expired) || gone.length > 0 || !moves.length;
  };

  const listKeys = (event, rows, row, activate) => {
    const index = rows.indexOf(row); let target;
    if (event.key === 'ArrowDown') target = rows[index + 1]; else if (event.key === 'ArrowUp') target = rows[index - 1]; else if (event.key === 'Home') target = rows[0]; else if (event.key === 'End') target = rows.at(-1);
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); return; } else return;
    event.preventDefault(); if (target) rove(rows, target);
  };
  const commitPager = (section, side, list) => {
    if (list.count <= 25) return;
    const nav = node('div', 'pager'), previous = button('link', 'Previous 25', `page:${side}:previous`), next = button('link', 'Next 25', `page:${side}:next`), more = list.offset + 25 < list.count && list.offset + 25 <= 1000000;
    previous.disabled = busy || list.offset === 0; next.disabled = busy || !more;
    previous.addEventListener('click', () => { if (list.offset > 0) act('page', { side, offset: list.offset - 25 }); });
    next.addEventListener('click', () => { if (more) act('page', { side, offset: list.offset + 25 }); });
    nav.append(previous, next, node('span', 'caption', `${(list.offset + 1).toLocaleString()}–${(list.offset + list.commits.length).toLocaleString()} of ${list.count.toLocaleString()}`)); section.append(nav);
  };
  const renderCommits = () => {
    commitsPane.replaceChildren(); const show = state?.mode === 'commits' && Boolean(state.sides && state.right);
    commitsPane.hidden = !show; workspace.className = show ? 'with-commits' : 'files-only';
    if (!show) return;
    const selected = state.files?.commit?.oid;
    for (const side of ['left', 'right']) {
      const list = side === 'left' ? state.sides.leftOnly : state.sides.rightOnly, from = side === 'left' ? state.left : state.right, to = side === 'left' ? state.right : state.left;
      const label = `Commits in ${from.name}, not in ${to.name}`, section = node('section', 'commit-side'); section.setAttribute('aria-label', label);
      const header = node('h2', 'pane-heading'); header.append(node('span', 'heading-text', label), node('span', 'count', list.count.toLocaleString())); section.append(header);
      // WebStorm's wording: nothing here means the other side already has all of these commits.
      if (!list.commits.length) section.append(node('p', 'empty', `Every commit of ${from.name} is already in ${to.name}`));
      else {
        const box = node('div', 'commit-rows'), rows = []; box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', label);
        for (const commit of list.commits) {
          const row = keyed(node('div', 'commit-row'), `commit:${side}:${commit.oid}`), date = new Date(commit.timestamp * 1000), refs = (commit.refs || []).join(', '), current = commit.oid === selected;
          row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(current)); row.tabIndex = -1; row.title = `${short(commit.oid)}  ${commit.subject}`;
          row.setAttribute('aria-label', `${commit.subject}, ${commit.author}, ${short(commit.oid)}, ${date.toLocaleString()}${refs ? `, refs ${refs}` : ''}`);
          const subject = node('span', 'commit-subject'); for (const ref of commit.refs || []) subject.append(node('span', 'ref-badge', ref)); subject.append(node('span', 'subject-text', commit.subject));
          const when = node('span', 'commit-date', relative(commit.timestamp)); when.title = date.toLocaleString();
          row.append(node('span', 'commit-hash', short(commit.oid)), subject, node('span', 'commit-author', commit.author), when);
          const choose = () => { if (!current) act('selectCommit', { oid: commit.oid }); };
          tag(row, { webviewSection: 'commit', oid: commit.oid, commitShown: current });
          row.addEventListener('click', () => { rove(rows, row); choose(); });
          row.addEventListener('contextmenu', () => rove(rows, row));
          row.addEventListener('keydown', event => listKeys(event, rows, row, choose));
          rows.push(row); box.append(row);
        }
        (rows.find(row => row.getAttribute('aria-selected') === 'true') || rows[0]).tabIndex = 0; section.append(box);
      }
      commitPager(section, side, list); commitsPane.append(section);
    }
  };

  const renderModes = files => {
    modeGroup.replaceChildren(); const show = state?.mode === 'commits' && Boolean(files) && files.scope !== 'commit'; modeGroup.hidden = !show;
    if (!show) return;
    modeGroup.append(node('span', 'files-label', 'Files:'));
    const options = [['fork', 'Since fork', 'What the left side changed since it forked (merge base)'], ['tips', 'Tip to tip', 'Differences between the two branch tips']];
    for (const [value, label, hint] of options) {
      const checked = state.filesMode === value, option = button('radio', label, `mode:${value}`), other = options.find(item => item[0] !== value)[0];
      option.setAttribute('role', 'radio'); option.setAttribute('aria-checked', String(checked)); option.tabIndex = checked ? 0 : -1; option.disabled = busy; option.title = hint;
      option.addEventListener('click', () => { if (!checked) act('filesMode', { mode: value }); });
      option.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); restoreKey = `mode:${other}`; act('filesMode', { mode: other }); } });
      modeGroup.append(option);
    }
  };
  const markChosen = () => {
    for (const row of treeRows) if (row.dataset.index !== undefined) { const index = Number(row.dataset.index); row.setAttribute('aria-selected', String(chosen.has(index))); if (state && fileItems.has(index)) tagFile(row, fileItems.get(index)); }
    if (!state?.left) return;
    const total = chosen.size, name = state.left.name;
    getButton.textContent = total > 1 ? `Get ${total} Files from ${name}` : `Get from ${name}`; getButton.disabled = busy || !total;
    getButton.setAttribute('aria-label', total ? `Get ${count(total, 'file')} from ${name}, replacing the working copies` : `Get from ${name}: select files first`);
    selectionHint.textContent = total ? `${count(total, 'file')} selected` : 'Select files to replace their working copies with the version in the branch.';
    remember();
  };
  const pick = (index, event) => {
    if (event.shiftKey && anchor !== undefined) {
      const order = treeRows.filter(row => row.dataset.index !== undefined).map(row => Number(row.dataset.index)), from = order.indexOf(anchor), to = order.indexOf(index);
      chosen.clear(); if (from >= 0 && to >= 0) for (const value of order.slice(Math.min(from, to), Math.max(from, to) + 1).slice(0, 100)) chosen.add(value); else chosen.add(index);
    } else if (chosen.has(index)) chosen.delete(index);
    else if (chosen.size < 100) chosen.add(index); else { status.textContent = 'Select up to 100 files at a time.'; status.className = ''; }
    if (!event.shiftKey) anchor = index; markChosen();
  };
  // A row names the files a menu command acts on: its own, or the whole selection when it is part of it (the native menu only sees the clicked element).
  const tagFile = (row, item) => {
    const worktree = state.mode === 'worktree', picked = worktree && chosen.has(item.index) ? [...chosen] : [item.index];
    tag(row, { webviewSection: 'file', index: item.index, indexes: picked.join(','), compareWorktree: worktree, fileOnlyInBranch: item.presence === 'branch' });
  };
  const treeKeys = (event, row, entry, activate) => {
    const index = treeRows.indexOf(row); let target;
    if (event.key === 'ArrowDown') target = treeRows[index + 1]; else if (event.key === 'ArrowUp') target = treeRows[index - 1]; else if (event.key === 'Home') target = treeRows[0]; else if (event.key === 'End') target = treeRows.at(-1);
    else if (event.key === 'ArrowRight' && entry.dir) { if (collapsed.has(entry.dir)) { event.preventDefault(); activate(); return; } target = treeRows[index + 1]; }
    else if (event.key === 'ArrowLeft') { if (entry.dir && !collapsed.has(entry.dir)) { event.preventDefault(); activate(); return; } if (entry.parent) target = focusables.get(`dir:${entry.parent}`); }
    else if (event.key === 'Enter') { event.preventDefault(); activate(); return; }
    else if (event.key === ' ') { event.preventDefault(); if (entry.item && state.mode === 'worktree') pick(entry.item.index, { ctrlKey: true }); else activate(); return; }
    else return;
    event.preventDefault(); if (target) rove(treeRows, target);
  };
  const dirRow = entry => {
    const open = !collapsed.has(entry.dir), row = keyed(node('div', 'tree-row dir-row'), `dir:${entry.dir}`);
    row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', '1'); row.setAttribute('aria-expanded', String(open)); row.setAttribute('aria-label', `${entry.dir}, ${count(entry.count, 'file')}`); row.tabIndex = -1; row.title = entry.dir;
    const twisty = glyph(open ? 'chevron-down' : 'chevron-right'); twisty.className += ' twisty';
    row.append(twisty, glyph('folder'), node('span', 'dir-name', entry.dir), node('span', 'dir-count', String(entry.count)));
    const toggle = () => { if (collapsed.has(entry.dir)) collapsed.delete(entry.dir); else collapsed.add(entry.dir); lastTreeKey = row.dataset.focusKey; restoreKey = lastTreeKey; render(); };
    row.addEventListener('click', toggle);
    row.addEventListener('focus', () => { lastTreeKey = row.dataset.focusKey; remember(); });
    row.addEventListener('keydown', event => treeKeys(event, row, entry, toggle));
    return row;
  };
  const fileRow = entry => {
    const item = entry.item, worktree = state.mode === 'worktree', slash = item.path.lastIndexOf('/'), name = item.path.slice(slash + 1), dir = slash > 0 ? item.path.slice(0, slash) : '';
    const row = keyed(node('div', `tree-row file-row level-${entry.level}`), `file:${item.index}`);
    row.dataset.status = item.status; row.dataset.index = String(item.index); if (item.presence) row.dataset.presence = item.presence;
    row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(entry.level)); row.tabIndex = -1; if (worktree) row.setAttribute('aria-selected', String(chosen.has(item.index)));
    const stats = item.binary ? 'Binary' : typeof item.added === 'number' ? `${item.added} added, ${item.removed} removed` : '';
    const words = [item.path, statusWords[item.status] || item.status, presenceText(item), item.originalPath ? `renamed from ${item.originalPath}` : '', stats].filter(Boolean).join(', ');
    row.setAttribute('aria-label', words); row.title = words;
    const main = node('span', 'file-main'); main.append(node('span', 'file-name', name)); if (flat && dir) main.append(node('span', 'file-dir', dir)); if (item.originalPath) main.append(node('span', 'file-origin', `← ${item.originalPath}`)); row.append(main);
    const stat = node('span', 'file-stat');
    if (item.binary) stat.textContent = 'Binary'; else if (typeof item.added === 'number') { if (item.added || !item.removed) stat.append(node('span', 'stat-added', `+${item.added}`)); if (item.removed) stat.append(node('span', 'stat-removed', `−${item.removed}`)); }
    row.append(stat);
    // Inline actions as in native Source Control: shown on hover and focus, kept out of the tab order, each one also in the context menu.
    const actions = node('span', 'row-actions'); actions.setAttribute('aria-hidden', 'true');
    for (const [type, label, icon] of [...(worktree ? [] : [['localDiff', 'Compare with Local', 'git-compare']]), ['openFile', 'Open File', 'go-to-file']]) {
      if (type === 'openFile' && item.presence === 'branch') continue;
      const inline = button('icon-button', undefined); inline.tabIndex = -1; inline.title = label; inline.setAttribute('aria-label', label); inline.dataset.inlineAction = type; inline.disabled = busy; inline.append(glyph(icon));
      inline.addEventListener('click', event => { event.stopPropagation(); act(type, { index: item.index }); }); inline.addEventListener('dblclick', event => event.stopPropagation()); actions.append(inline);
    }
    row.append(actions);
    const letter = node('span', 'file-status', item.status); letter.setAttribute('aria-hidden', 'true'); row.append(letter);
    const open = () => act('diff', { index: item.index });
    row.addEventListener('click', event => {
      rove(treeRows, row);
      if (worktree && (event.ctrlKey || event.metaKey || event.shiftKey)) { pick(item.index, event); return; }
      if (worktree) { chosen.clear(); chosen.add(item.index); anchor = item.index; markChosen(); }
      open();
    });
    row.addEventListener('focus', () => { lastTreeKey = row.dataset.focusKey; remember(); });
    // As in the Explorer, a right-click on a row outside the selection selects just that row before the menu opens.
    row.addEventListener('contextmenu', () => { rove(treeRows, row); if (worktree && !chosen.has(item.index)) { chosen.clear(); chosen.add(item.index); anchor = item.index; markChosen(); } });
    tagFile(row, item); fileItems.set(item.index, item);
    row.addEventListener('keydown', event => treeKeys(event, row, entry, open));
    return row;
  };
  const renderFiles = () => {
    tree.replaceChildren(); heading.replaceChildren(); pager.replaceChildren(); legend.replaceChildren(); treeRows = []; fileItems.clear();
    const files = state?.files, worktree = state?.mode === 'worktree';
    renderModes(files);
    layout.replaceChildren(glyph(flat ? 'list-tree' : 'list-flat')); layout.title = flat ? 'View as Tree' : 'View as List'; layout.setAttribute('aria-label', layout.title); layout.disabled = busy;
    worktreeBar.hidden = true; pager.hidden = true; legend.hidden = true; footer.textContent = '';
    // The tree only ever holds treeitems: an empty or omitted list is said beside it, and the empty tree is hidden.
    const empty = text => { tree.hidden = true; filesEmpty.hidden = false; filesEmpty.textContent = text; };
    tree.hidden = false; filesEmpty.hidden = true; filesEmpty.textContent = '';
    if (!files) { tree.hidden = true; heading.append(node('p', state?.error ? 'error' : 'muted', state?.error || 'Loading comparison…')); return; }
    const head = node('div', 'files-title');
    if (files.scope === 'commit' && files.commit) {
      head.append(node('span', 'heading-text', `Files in ${short(files.commit.oid)} · ${files.commit.subject}`));
      const back = button('link', 'All changes', 'all-changes'); back.disabled = busy; back.addEventListener('click', () => act('allChanges')); head.append(back);
    } else head.append(node('span', 'heading-text', files.scope === 'worktree' ? `Changed files · ${files.total.toLocaleString()}` : files.scope === 'fork' ? `Changes in ${state.left.name} since the fork point · ${files.total.toLocaleString()}` : `Changes between the tips · ${files.total.toLocaleString()}`));
    heading.append(head);
    if (files.note === 'multipleMergeBases') heading.append(node('p', 'note', `Multiple merge bases; showing changes since ${short(files.from)}.`));
    if (files.note === 'noCommonAncestor') heading.append(node('p', 'note', 'No common ancestor; showing tip-to-tip file changes.'));
    if (files.note === 'shallowHistory') heading.append(node('p', 'note', 'This repository is a shallow clone, so the common ancestor and the commit counts may be incomplete; showing tip-to-tip file changes.'));
    if (worktree) {
      legend.hidden = false;
      for (const [presence, text] of [['branch', `Only in ${state.left.name}`], ['worktree', 'Only in the working tree'], ['both', 'Changed in both']]) {
        const chip = node('span', 'legend-item'), swatch = node('span', 'swatch'); chip.dataset.presence = presence; swatch.setAttribute('aria-hidden', 'true'); chip.append(swatch, node('span', '', text)); legend.append(chip);
      }
    }
    tree.setAttribute('aria-multiselectable', String(worktree));
    if (files.omitted) { empty(files.note === 'nonUtf8Path' ? 'Some changed paths are not valid UTF-8, so the file list is unavailable here; use a terminal for this comparison.' : 'Too many changed files to list here.'); return; }
    if (!files.total) { empty(worktree ? `No differences between ${state.left.name} and the working tree.` : 'No differences.'); return; }
    const entries = [];
    if (flat) for (const item of files.items) entries.push({ item, level: 1 });
    else {
      // Directories first, compact (one row per directory path), then the files at the root, as the native SCM tree orders them.
      const groups = new Map();
      for (const item of files.items) { const slash = item.path.lastIndexOf('/'), dir = slash > 0 ? item.path.slice(0, slash) : ''; if (!groups.has(dir)) groups.set(dir, []); groups.get(dir).push(item); }
      for (const dir of [...groups.keys()].filter(Boolean).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
        entries.push({ dir, count: groups.get(dir).length });
        if (!collapsed.has(dir)) for (const item of groups.get(dir)) entries.push({ item, level: 2, parent: dir });
      }
      for (const item of groups.get('') || []) entries.push({ item, level: 1 });
    }
    for (const entry of entries) { const row = entry.dir !== undefined ? dirRow(entry) : fileRow(entry); treeRows.push(row); tree.append(row); }
    const entry = treeRows.find(row => row.dataset.focusKey === lastTreeKey) || treeRows[0]; if (entry) entry.tabIndex = 0;
    if (files.total > 200) {
      pager.hidden = false;
      const previous = button('link', 'Previous 200', 'files:previous'), next = button('link', 'Next 200', 'files:next');
      previous.disabled = busy || files.offset === 0; next.disabled = busy || files.offset + 200 >= files.total;
      previous.addEventListener('click', () => { if (files.offset > 0) act('filesPage', { offset: files.offset - 200 }); });
      next.addEventListener('click', () => { if (files.offset + 200 < files.total) act('filesPage', { offset: files.offset + 200 }); });
      pager.append(previous, next, node('span', 'caption', `Files ${(files.offset + 1).toLocaleString()}–${(files.offset + files.items.length).toLocaleString()} of ${files.total.toLocaleString()}`));
    }
    footer.textContent = [count(files.total, 'file'), files.binary ? `${files.binary.toLocaleString()} binary not in All Changes` : '', files.total - files.binary > 300 ? 'All Changes opens the first 300' : ''].filter(Boolean).join(' · ');
    if (worktree) { worktreeBar.hidden = false; markChosen(); }
  };
  const renderToolbar = () => {
    const files = state?.files, ready = Boolean(state && !state.loading && files);
    keyed(swapButton, 'toolbar:swap'); keyed(refreshButton, 'toolbar:refresh'); keyed(openAll, 'toolbar:openAll'); keyed(movedRefresh, 'toolbar:moved'); keyed(getButton, 'files:get'); keyed(layout, 'files:layout');
    swapButton.disabled = busy || !ready; refreshButton.disabled = busy || !state; movedRefresh.disabled = busy;
    openAll.disabled = busy || !ready || files.omitted || !files.total || files.binary >= files.total;
    openAll.title = files?.scope === 'commit' && files.commit ? `Open All Changes in ${short(files.commit.oid)}` : 'Open All Changes'; openAll.setAttribute('aria-label', openAll.title);
    workspace.setAttribute('aria-busy', String(busy));
  };
  const render = () => {
    // The row that had focus before the renderer was recreated, once the replayed files are there.
    if (pendingFocus && state?.files && !busy) { restoreKey = restoreKey || pendingFocus; pendingFocus = undefined; }
    const active = document.activeElement, owned = active && active !== document.body && active.dataset?.focusKey;
    const key = owned || (!busy ? restoreKey : undefined), focused = typeof document.hasFocus !== 'function' || document.hasFocus();
    focusables.clear();
    renderHeader(); renderSummary(); renderCommits(); renderFiles(); renderToolbar();
    if (busy) return;
    restoreKey = undefined;
    if (!key || !focused) return;
    // A row or page link that no longer exists hands focus to the same list, then to its pane, then to the heading.
    const prefix = `${key.split(':').slice(0, key.startsWith('commit:') || key.startsWith('page:') ? 2 : 1).join(':')}:`, filesPane = /^(?:file|dir|files|mode|all-changes)\b/.test(key);
    const target = [focusables.get(key), [...focusables.values()].find(element => element.dataset.focusKey.startsWith(prefix) && !element.disabled), filesPane ? treeRows.find(row => row.tabIndex === 0) : undefined].find(element => element && !element.disabled);
    if (target) target.focus(); else title.focus?.();
  };

  swapButton.addEventListener('click', () => act('swap'));
  openAll.addEventListener('click', () => act('openAll'));
  const refresh = () => { if (!busy && state) { status.textContent = ''; status.className = ''; send({ type: 'refresh' }); } };
  refreshButton.addEventListener('click', refresh); movedRefresh.addEventListener('click', refresh);
  layout.addEventListener('click', () => { flat = !flat; remember(); restoreKey = 'files:layout'; render(); });
  getButton.addEventListener('click', () => { if (chosen.size) act('getFromBranch', { indexes: [...chosen] }); });
  window.addEventListener('message', event => {
    const data = event.data; if (!data || typeof data !== 'object' || data.session !== session) return;
    if (data.type === 'state') {
      // A new revision is a new captured file list: indexes chosen for Get from Branch no longer apply.
      if (data.revision !== revision) { chosen.clear(); anchor = undefined; }
      revision = data.revision; state = data; render(); remember(); return;
    }
    if (data.type === 'busy') {
      const next = data.busy === true; if (next && !busy) { const active = document.activeElement; restoreKey = restoreKey || active?.dataset?.focusKey; }
      busy = next; render(); return;
    }
    if (data.type === 'error' || data.type === 'notice') { status.textContent = typeof data.message === 'string' ? data.message : 'Compare action failed.'; status.className = data.type === 'error' ? 'error' : ''; }
  });
  render();
  send({ type: 'ready' });
})();
