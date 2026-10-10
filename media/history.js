(() => {
  // Virtual row height in px; CSS .commit uses the same 24px.
  const ROW = 24;
  const api = acquireVsCodeApi(), session = document.body.dataset.session;
  const viewport = document.getElementById('viewport'), rows = document.getElementById('rows'), spacer = document.getElementById('spacer'), details = document.getElementById('details'), status = document.getElementById('status'), workspace = document.getElementById('workspace');
  const stored = api.getState?.();
  const saved = stored && typeof stored === 'object' ? stored : {};
  const filterDisclosure = document.getElementById('filter-disclosure');
  const cancelRead = document.getElementById('cancel-read');
  const compactQuery = window.matchMedia?.('(max-width: 479px)');
  let filtersChosen = typeof saved.filtersExpanded === 'boolean';
  filterDisclosure.open = filtersChosen ? saved.filtersExpanded : !compactQuery?.matches;
  const bounded = (value, max) => Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
  const scope = value => typeof value === 'string' && value.length <= 256 ? value : '';
  let commits = [], graph = [], refs = [], selected = -1, busy = false, canCancel = false, laneWidth = 12;
  let refsSlot;
  let pageRevision = 0, renderedWindow, graphWidthSnapshot, visibleRows = [];
  let focusBeforeBusy, fileScope = scope(saved.fileScope), fileOffset = bounded(saved.fileOffset, 1000000);
  let comparisonScope = scope(saved.comparisonScope), comparisonExpanded = saved.comparisonExpanded === true;
  laneWidth = [9,12,18].includes(saved.zoom) ? saved.zoom : 12;
  document.getElementById('zoom').value = String(laneWidth);
  let restoreScroll = bounded(saved.scrollTop, 80000);
  let lastPresentationKey;
  const remember = () => { const state = {scrollTop: Math.min(80000, Math.max(0, Math.round(viewport.scrollTop))), zoom:laneWidth,filtersExpanded:filtersChosen ? filterDisclosure.open : undefined,fileScope,fileOffset,comparisonScope,comparisonExpanded}; const key = JSON.stringify(state); if (key === lastPresentationKey) return; api.setState?.(state); lastPresentationKey = key.length <= 2048 ? key : undefined; };
  filterDisclosure.addEventListener('toggle', remember);
  filterDisclosure.querySelector?.('summary')?.addEventListener('click', () => { filtersChosen = true; });
  compactQuery?.addEventListener('change', event => { if (!filtersChosen && !(event.matches && filterDisclosure.contains?.(document.activeElement))) filterDisclosure.open = !event.matches; });
  const send = value => api.postMessage({ ...value, session });
  const text = (parent, tag, value) => { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; };
  const icon = (parent, kind) => {
    const glyph = document.createElement('span'); glyph.className = `codicon codicon-${{ copy: 'copy', branch: 'git-branch', remote: 'cloud', tag: 'tag', ref: 'link', commit: 'git-commit', info: 'info' }[kind]}`;
    glyph.setAttribute('aria-hidden', 'true'); parent.append(glyph);
  };
  const showGuidance = () => {
    details.replaceChildren(); const guidance = document.createElement('div'); guidance.className = 'details-guidance';
    const heading = document.createElement('h2'); icon(heading, 'commit'); text(heading, 'span', 'Commit details'); guidance.append(heading);
    text(guidance, 'p', 'Select a commit to review its message, refs and changed files.');
    text(guidance, 'p', 'Use ↑ / ↓ to move between commits.'); details.append(guidance);
  };
  // Containing refs arrive after the details; a slow or failed lookup only changes this section.
  const showRefs = (container, values, error) => {
    container.replaceChildren(); container.setAttribute('aria-busy', String(!Array.isArray(values) && !error));
    if (!Array.isArray(values)) { text(container, 'h3', 'Containing refs'); const note = text(container, 'p', error ? `Containing refs unavailable: ${error}` : 'Finding containing refs…'); note.className = 'refs-note'; return; }
    text(container, 'h3', `Containing refs · ${values.length}`);
    const chips = (parent, start, end) => {
      for (let index = start; index < end; index++) {
        const value = values[index], kind = value.startsWith('refs/heads/') ? 'branch' : value.startsWith('refs/remotes/') ? 'remote' : value.startsWith('refs/tags/') ? 'tag' : 'ref';
        const chip = document.createElement('span'); chip.className = `ref-chip ref-${kind}`; chip.title = value; icon(chip, kind);
        const type = text(chip, 'span', {branch:'Branch',remote:'Remote',tag:'Tag',ref:'Ref'}[kind]); type.className = 'ref-kind';
        const name = text(chip, 'span', value.replace(/^refs\/(heads|remotes|tags)\//, '')); name.className = 'ref-name'; parent.append(chip);
      }
    };
    const preview = document.createElement('div'); preview.className = 'ref-chips'; chips(preview, 0, Math.min(8, values.length)); container.append(preview);
    if (!values.length) text(container, 'p', 'No containing refs.');
    if (values.length > 8) {
      const disclosure = document.createElement('details'); disclosure.className = 'refs-disclosure';
      const summary = text(disclosure, 'summary', `Show all ${values.length.toLocaleString()} refs`); summary.className = 'refs-toggle'; summary.setAttribute('aria-disabled', String(busy));
      const expanded = document.createElement('div'); expanded.className = 'ref-expanded'; disclosure.append(expanded); let offset = 0;
      const render = () => {
        expanded.replaceChildren(); const navigation = document.createElement('div'); navigation.className = 'ref-navigation';
        const previous = text(navigation, 'button', 'Previous refs'), next = text(navigation, 'button', 'Next refs');
        const end = Math.min(values.length, offset + 200), caption = text(navigation, 'span', `Refs ${offset + 1}–${end} of ${values.length.toLocaleString()}`); caption.setAttribute('aria-live', 'polite');
        previous.dataset.available = String(offset > 0); next.dataset.available = String(end < values.length); previous.disabled = busy || offset === 0; next.disabled = busy || end === values.length;
        const list = document.createElement('div'); list.className = 'ref-chips'; chips(list, offset, end); expanded.append(navigation, list);
        const page = (control, advance) => { if (busy || !container.isConnected || !control.isConnected || !disclosure.open) return; const focused = document.activeElement === control; offset += advance; render(); if (focused && (typeof document.hasFocus !== 'function' || document.hasFocus())) expanded.children[0].children[advance > 0 && offset + 200 >= values.length ? 0 : advance < 0 && offset === 0 ? 1 : advance > 0 ? 1 : 0].focus(); };
        previous.addEventListener('click', () => { if (offset > 0) page(previous, -200); }); next.addEventListener('click', () => { if (end < values.length) page(next, 200); });
      };
      summary.addEventListener('click', event => { if (busy || !container.isConnected) event.preventDefault(); });
      disclosure.addEventListener('toggle', () => {
        if (!container.isConnected) return;
        if (busy && disclosure.open) disclosure.open = false;
        preview.hidden = disclosure.open; summary.textContent = `${disclosure.open ? 'Hide' : 'Show all'} ${values.length.toLocaleString()} refs`;
        if (disclosure.open) render(); else { expanded.replaceChildren(); offset = 0; }
      }); container.append(disclosure);
    }
  };
  const showFiles = (files, stats, scope) => {
    if (scope !== fileScope) { fileScope = scope; fileOffset = 0; }
    if (fileOffset >= files.length) fileOffset = 0;
    if (!files.length) { text(details, 'p', 'No changed files.'); return; }
    const list = document.createElement('ul'), navigation = document.createElement('div'), caption = document.createElement('span'); navigation.className = 'file-pager';
    const previous = text(navigation, 'button', 'Previous files'), next = text(navigation, 'button', 'Next files'); navigation.append(caption); caption.setAttribute('aria-live', 'polite');
    const byPath = new Map(stats.map(stat => [stat.path, stat])); let offset = fileOffset;
    const render = () => {
      fileOffset = offset; remember(); list.replaceChildren(); const end = Math.min(files.length, offset + 200);
      for (let index = offset; index < end; index++) { const file = files[index], li = document.createElement('li'), button = document.createElement('button'), stat = byPath.get(file.path); li.dataset.status = String(file.status).charAt(0); button.className = 'file-row';
        // The full status, rename and stat text stays the accessible name; the visible row splits it into styled parts.
        const label = `${file.status} ${file.originalPath ? file.originalPath + ' → ' : ''}${file.path}${stat ? stat.added === null ? ' · Binary' : ` · +${stat.added} / −${stat.removed}` : ''}`, slash = file.path.lastIndexOf('/'); button.setAttribute('aria-label', label); button.title = label;
        text(button, 'span', String(file.status).charAt(0)).className = 'file-status'; text(button, 'span', file.path.slice(slash + 1)).className = 'file-name'; if (slash > 0) text(button, 'span', file.path.slice(0, slash)).className = 'file-dir';
        if (stat) { const counts = document.createElement('span'); counts.className = 'file-stat'; if (stat.added === null) counts.textContent = 'Binary'; else { if (stat.added > 0 || !(stat.removed > 0)) text(counts, 'span', `+${stat.added}`).className = 'file-added'; if (stat.removed > 0) text(counts, 'span', `−${stat.removed}`).className = 'file-removed'; } button.append(counts); }
        button.disabled = busy; button.addEventListener('click', () => { if (!busy) send({ type: 'diff', index }); }); li.append(button); const working = text(li, 'button', 'Compare saved working file'); working.className = 'file-working'; working.title = 'Compare saved working file'; working.setAttribute('aria-label', `Compare saved working file: ${file.path}`); working.disabled = busy; working.addEventListener('click', () => { if (!busy) send({ type: 'workingDiff', index }); }); list.append(li); }
      caption.textContent = ` Files ${offset + 1}–${end} of ${files.length}`; previous.dataset.available = String(offset > 0); next.dataset.available = String(end < files.length); previous.disabled = busy || offset === 0; next.disabled = busy || end === files.length;
    };
    const page = (control, fallback, nextOffset) => { const ownedFocus = document.activeElement === control; offset = nextOffset; render(); if (!ownedFocus || !control.disabled || fallback.disabled || (typeof document.hasFocus === 'function' && !document.hasFocus())) return; const active = document.activeElement; if (active && active !== control && active !== document.body && active.tagName !== 'HTML' && active.isConnected && !active.disabled) return; fallback.focus(); }; previous.addEventListener('click', () => { if (!busy && offset > 0) page(previous, next, offset - 200); }); next.addEventListener('click', () => { if (!busy && offset + 200 < files.length) page(next, previous, offset + 200); }); details.append(navigation, list); render();
  };
  const updateRowText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const updateRowTitle = (node, value) => { if (node.title !== value) node.title = value; };
  const updateGraphAttribute = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  const createVisibleRow = slot => {
    const row = document.createElement('div'), ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    row.id = `commit-${slot}`; row.className = 'commit'; row.setAttribute('role', 'option'); svg.setAttribute('height', String(ROW)); svg.setAttribute('aria-hidden', 'true'); row.append(svg);
    const badge = text(row, 'span', ''); badge.className = 'refs'; badge.hidden = true;
    const title = document.createElement('span'); title.className = 'subject';
    const hash = text(title, 'span', ''); hash.className = 'commit-hash'; const subject = text(title, 'span', ''); row.append(title);
    const meta = document.createElement('span'); meta.className = 'meta';
    const author = text(meta, 'span', ''); author.className = 'commit-author'; text(meta, 'span', '·'); const date = text(meta, 'span', ''); date.className = 'commit-date'; row.append(meta);
    const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cy', String(ROW / 2)); dot.setAttribute('r', '4'); dot.setAttribute('fill', 'currentColor'); svg.append(dot);
    const view = { row, svg, badge, title, hash, subject, meta, author, date, dot, lines: [], index: -1, revision: -1, laneWidth: -1 };
    row.addEventListener('click', () => { if (row.isConnected) select(view.index); }); return view;
  };
  const draw = () => {
    const start = Math.max(0, Math.floor(viewport.scrollTop / ROW) - 1), end = Math.min(commits.length, start + Math.ceil(viewport.clientHeight / ROW) + 3);
    if (renderedWindow && renderedWindow.start === start && renderedWindow.end === end && renderedWindow.selected === selected && renderedWindow.laneWidth === laneWidth && renderedWindow.pageRevision === pageRevision) return;
    if (!graphWidthSnapshot || graphWidthSnapshot.revision !== pageRevision || graphWidthSnapshot.laneWidth !== laneWidth) { graphWidthSnapshot = { revision: pageRevision, laneWidth, width: Math.max(24, ...graph.map(row => Math.max(row.before.length, row.after.length) * laneWidth + laneWidth)) }; viewport.style?.setProperty?.('--gp-graph-width', graphWidthSnapshot.width + 'px'); }
    const graphWidth = graphWidthSnapshot.width; spacer.style.minWidth = `calc(${graphWidth}px + var(--history-row-reserve, 400px))`; spacer.style.height = `${commits.length * ROW}px`; rows.style.top = `${start * ROW}px`;
    const count = Math.max(0, end - start);
    if (visibleRows.length !== count) { rows.replaceChildren(); visibleRows = Array.from({ length: count }, (_, slot) => createVisibleRow(slot)); rows.append(...visibleRows.map(view => view.row)); } else if (renderedWindow) {
      const delta = start - renderedWindow.start;
      if (delta > 0 && delta < count) { const moved = visibleRows.splice(0, delta); visibleRows.push(...moved); rows.append(...moved.map(view => view.row)); }
      else if (delta < 0 && -delta < count) { const moved = visibleRows.splice(count + delta); visibleRows.unshift(...moved); rows.prepend(...moved.map(view => view.row)); }
    }
    let formattedDay;
    const displayDate = timestamp => {
      const date = new Date(timestamp * 1000), year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
      if (formattedDay && formattedDay.year === year && formattedDay.month === month && formattedDay.day === day) return formattedDay.text;
      const value = date.toLocaleDateString(); formattedDay = { year, month, day, text: value }; return value;
    };
    for (let i = start; i < end; i++) {
      const view = visibleRows[i - start], { row, svg } = view;
      if (view.index !== i || view.revision !== pageRevision || view.laneWidth !== laneWidth) {
        const commit = commits[i], rowGraph = graph[i]; row.setAttribute('aria-posinset', String(i + 1)); updateGraphAttribute(row, 'aria-setsize', String(commits.length)); updateGraphAttribute(row, 'data-merge', String(commit.parents.length > 1)); updateGraphAttribute(svg, 'width', String(graphWidth));
        if (view.lines.length !== rowGraph.edges.length) {
          svg.replaceChildren(); view.lines = rowGraph.edges.map(() => { const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('y2', String(ROW)); line.setAttribute('stroke', 'currentColor'); return line; }); svg.append(...view.lines, view.dot);
        }
        // Lane classes colour the graph through CSS; six colours repeat across lanes.
        rowGraph.edges.forEach((edge, index) => { const line = view.lines[index]; updateGraphAttribute(line, 'class', `lane-${edge.to % 6}`); updateGraphAttribute(line, 'x1', String(edge.from * laneWidth + laneWidth / 2)); updateGraphAttribute(line, 'y1', edge.from === rowGraph.lane ? String(ROW / 2) : '0'); updateGraphAttribute(line, 'x2', String(edge.to * laneWidth + laneWidth / 2)); if (edge.boundary) updateGraphAttribute(line, 'stroke-dasharray', '3 2'); else if (line.getAttribute('stroke-dasharray') !== null && line.getAttribute('stroke-dasharray') !== undefined) line.removeAttribute('stroke-dasharray'); });
        updateGraphAttribute(view.dot, 'cx', String(rowGraph.lane * laneWidth + laneWidth / 2)); updateGraphAttribute(view.dot, 'class', `lane-${rowGraph.lane % 6}`);
        // Edges end at the row boundary; CSS draws the top half into the node from these row-level hints, so the SVG keeps one line per edge.
        updateGraphAttribute(row, 'data-incoming', String(i > 0 && graph[i - 1]?.after?.[rowGraph.lane] === commit.oid)); updateGraphAttribute(row, 'data-lane', String(rowGraph.lane % 6)); row.style?.setProperty?.('--gp-node-x', `${rowGraph.lane * laneWidth + laneWidth / 2}px`);
        const named = refs.filter(ref => ref.oid === commit.oid), decorations = named.map(ref => ref.name).join(', '); if (view.badge.hidden !== !decorations) view.badge.hidden = !decorations; updateRowText(view.badge, decorations); updateRowTitle(view.badge, decorations);
        updateGraphAttribute(view.badge, 'data-head', String(named.some(ref => ref.name === 'HEAD')));
        updateRowTitle(view.title, `${commit.oid.slice(0, 8)}  ${commit.subject}`); updateRowText(view.hash, `${commit.oid.slice(0, 8)}  `); updateRowText(view.subject, commit.subject);
        const date = displayDate(commit.timestamp); updateRowTitle(view.meta, `${commit.author} · ${date}`); updateRowText(view.author, commit.author); updateRowText(view.date, date);
        row.setAttribute('aria-label', `${commit.subject}, ${commit.author}, ${commit.oid.slice(0, 8)}, ${commit.parents.length} parents${decorations ? ', refs ' + decorations : ''}, ${date}`);
        view.index = i; view.revision = pageRevision; view.laneWidth = laneWidth;
      }
      const chosen = String(selected === i); if (row.getAttribute('aria-selected') !== chosen) row.setAttribute('aria-selected', chosen);
    }
    if (selected >= start && selected < end) viewport.setAttribute('aria-activedescendant', visibleRows[selected - start].row.id); else viewport.removeAttribute('aria-activedescendant');
    renderedWindow = { start, end, selected, laneWidth, pageRevision };
  };
  const select = index => { if (busy || !commits[index]) return; selected = index; draw(); send({ type: 'select', oid: commits[index].oid, parent: 0 }); };
  const showSide = (parent, label, side, commits, count, offset = 0) => {
    const shown = (commits || []).slice(0, 25); text(parent, 'h3', `${label}: ${count || 0} unique commit${count === 1 ? '' : 's'}`);
    if (!shown.length) text(parent, 'p', 'No unique commits.');
    const list = document.createElement('ul'); for (const commit of shown) { const li = document.createElement('li'), button = text(li, 'button', `${commit.oid.slice(0, 8)} ${commit.subject}`); button.dataset.focusKey = `compare:commit:${commit.oid}`; button.disabled = busy; button.addEventListener('click', () => { if (!busy) send({ type: 'select', oid: commit.oid, parent: 0 }); }); list.append(li); } parent.append(list);
    if (!count) return;
    const navigation = document.createElement('div'), previous = text(navigation, 'button', `Previous ${side} commits`), next = text(navigation, 'button', `Next ${side} commits`), caption = text(navigation, 'span', ` Commits ${offset + 1}–${offset + shown.length} of ${count}`); caption.setAttribute('aria-live', 'polite');
    navigation.className = 'file-pager'; previous.dataset.focusKey = `compare:${side}:previous`; next.dataset.focusKey = `compare:${side}:next`;
    previous.dataset.available = String(offset > 0); next.dataset.available = String(offset + 25 < count && offset + 25 <= 1000000); previous.disabled = busy || previous.dataset.available === 'false'; next.disabled = busy || next.dataset.available === 'false';
    previous.addEventListener('click', () => { if (!busy && offset > 0) send({ type: 'comparePage', side, offset: offset - 25 }); }); next.addEventListener('click', () => { if (!busy && next.dataset.available === 'true') send({ type: 'comparePage', side, offset: offset + 25 }); }); parent.append(navigation);
    if (offset + 25 > 1000000 && offset + shown.length < count) text(parent, 'p', 'Comparison page limit reached. Choose a narrower revision range.');
  };
  document.getElementById('zoom').addEventListener('change', event => { laneWidth = [9,12,18].includes(Number(event.target.value)) ? Number(event.target.value) : 12; remember(); draw(); }); viewport.addEventListener('scroll', () => { remember();draw(); });
  viewport.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? commits.length - 1 : Math.max(0, Math.min(commits.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))); if (busy) return; viewport.scrollTop = Math.max(0, index * ROW - viewport.clientHeight / 2); select(index); } });
  window.addEventListener('resize', draw);
  document.getElementById('filters').addEventListener('submit', event => { event.preventDefault(); if (!busy) send({ type: 'query', ...Object.fromEntries(new FormData(event.currentTarget)) }); });
  document.getElementById('compare').addEventListener('submit', event => { event.preventDefault(); if (!busy) send({ type: 'compare', ...Object.fromEntries(new FormData(event.currentTarget)) }); });
  document.getElementById('compare-swap')?.addEventListener('click', () => { const form = document.getElementById('compare'), from = form?.querySelector?.('[name=from]'), to = form?.querySelector?.('[name=to]'); if (!busy && from && to) [from.value, to.value] = [to.value, from.value]; });
  document.getElementById('more').addEventListener('click', () => { if (!busy) send({ type: 'more' }); });
  cancelRead.addEventListener('click', () => { if (busy && canCancel) { canCancel = false; cancelRead.disabled = true; send({ type: 'cancel' }); } });
  const restoreBusyFocus = () => {
    const saved = focusBeforeBusy; focusBeforeBusy = undefined; if (!saved) return;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    const active = document.activeElement; if (active && active !== saved.node && active !== document.body && active.tagName !== 'HTML' && active.isConnected && !active.disabled) return;
    const available = [...document.querySelectorAll('[data-focus-key]')].filter(node => !node.disabled);
    let target = saved.node.isConnected && !saved.node.disabled ? saved.node : available.find(node => node.dataset.focusKey === saved.key);
    if (!target && /^compare:(left|right):(next|previous)$/.test(saved.key || '')) { const alternate = saved.key.endsWith(':next') ? saved.key.replace(/:next$/, ':previous') : saved.key.replace(/:previous$/, ':next'); target = available.find(node => node.dataset.focusKey === alternate); }
    if (!target && (saved.key?.startsWith('compare:commit:') || saved.key === 'details-parent')) target = available.find(node => node.dataset.focusKey === 'details-heading');
    if (!target && saved.node.id === 'more') target = viewport;
    target?.focus();
  };
  window.addEventListener('message', event => {
    const item = event.data; if (!item || item.session !== session) return;
    if (item.type === 'page' || item.type === 'reset') pageRevision++;
    if (item.type === 'reset') { commits = []; graph = []; refs = []; selected = -1; document.getElementById('snapshot').textContent = ''; document.getElementById('filter-summary').textContent = 'No active snapshot'; fileScope = ''; fileOffset = 0; comparisonScope = ''; comparisonExpanded = false; restoreScroll=0;workspace.className = 'split'; viewport.scrollTop = 0; remember();showGuidance(); const pagination = document.getElementById('pagination'); pagination.replaceChildren(); pagination.hidden = true; const more = document.getElementById('more'); more.dataset.available = 'false'; more.disabled = true; draw(); }
    if (item.type === 'page') { commits = item.commits; graph = item.rows; refs = item.refs || []; document.getElementById('more').dataset.available = String(item.hasMore); const pagination = document.getElementById('pagination'); pagination.replaceChildren(); pagination.hidden = false; pagination.className = item.limitReached ? 'load-limit' : ''; icon(pagination, 'info'); text(pagination, 'span', item.limitReached ? `${commits.length.toLocaleString()} commits loaded · Load limit reached. Narrow the filters to find older commits. Refresh starts a new snapshot.` : item.hasMore ? `${commits.length.toLocaleString()} commits loaded · Load more to continue.` : `${commits.length.toLocaleString()} commits loaded · End of matching history.`); const summary = document.getElementById('filter-summary'), count = ['text','author','path','from','to'].filter(name => item.filters?.[name]).length; summary.textContent = `${item.ref || 'HEAD'} · ${count ? `${count} active filter${count === 1 ? '' : 's'}` : 'All commits'}`; summary.title = summary.textContent; const snapshot = document.getElementById('snapshot'); snapshot.textContent = `${commits.length} commits · Snapshot ${item.tips.map(tip => tip.slice(0, 8)).join(', ') || 'Unborn branch'} · Refresh to include new commits${item.fileHistory ? ` · Follows all merge parents · ${item.scanned} commit/path states scanned in this page` : ''}`; for(const name of ['ref','text','author','path','from','to']){const control=document.getElementById('filters').querySelector?.(`[name=${name}]`);if(control)control.value=name==='ref'?item.ref||'HEAD':item.filters[name]||'';}status.textContent = commits.length ? '' : item.hasMore ? 'No matching commits in this scan. Load more to continue.' : 'No commits match the current ref and filters.'; status.className = ''; draw();if(restoreScroll){viewport.scrollTop=Math.min(restoreScroll,Math.max(0,commits.length*ROW-viewport.clientHeight));restoreScroll=0;draw();} }
    if (item.type === 'selection') { selected = commits.findIndex(commit => commit.oid === item.oid); draw(); }
    if (item.type === 'details') {
      comparisonScope = ''; comparisonExpanded = false; workspace.className = 'split'; details.replaceChildren(); const value = item.details;
      selected = commits.findIndex(commit => commit.oid === value.commit.oid); draw();
      const heading = text(details, 'h2', value.commit.subject); heading.setAttribute('tabindex', '-1'); heading.dataset.focusKey = 'details-heading';
      const metadata = document.createElement('div'); metadata.className = 'details-metadata';
      const hash = text(metadata, 'code', value.commit.oid.slice(0, 8)); hash.title = value.commit.oid; hash.setAttribute('aria-label', `Commit ${value.commit.oid}`);
      text(metadata, 'span', `${value.commit.author}${value.commit.email ? ` <${value.commit.email}>` : ''} · ${new Date(value.commit.timestamp * 1000).toLocaleString()}`); details.append(metadata);
      const actions = document.createElement('div'); actions.className = 'details-actions';
      for (const [label, field] of [['Copy Hash', 'hash'], ['Copy Message', 'message']]) {
        const button = document.createElement('button'); icon(button, 'copy'); text(button, 'span', label); button.disabled = busy;
        button.addEventListener('click', () => { if (!busy && button.isConnected) send({ type: 'copy', oid: value.commit.oid, field }); }); actions.append(button);
      } details.append(actions);
      if (item.historicalPath) text(details, 'p', `Historical file: ${item.historicalPath}`);
      const refsSection = document.createElement('section'); refsSection.className = 'details-refs'; details.append(refsSection); refsSlot = { oid: value.commit.oid, container: refsSection }; showRefs(refsSection, value.refs, value.refsError);
      const newline = value.message.indexOf('\n'), firstLine = newline < 0 ? value.message : value.message.slice(0, newline);
      // The blank line Git keeps between subject and body is not part of the body.
      const body = firstLine === value.commit.subject ? newline < 0 ? '' : value.message.slice(newline + 1).replace(/^(?:\r?\n)+/, '') : value.message;
      if (body) { const message = text(details, 'pre', body); message.className = 'details-message'; }
      if (value.messageOmitted) text(details, 'p', 'The full message is too large to show here. Use native Git to read it.').className = 'refs-note';
      if (value.commit.parents.length > 1) { const label = text(details, 'label', 'Compare merge parent'); const control = document.createElement('select'); control.dataset.focusKey = 'details-parent'; value.commit.parents.forEach((oid, index) => { const option = text(control, 'option', `${index + 1}: ${oid.slice(0, 8)}`); option.value = String(index); }); control.value = String(item.parentIndex); control.addEventListener('change', () => { if (!busy) send({ type: 'select', oid: value.commit.oid, parent: Number(control.value) }); }); label.append(control); }
      if (value.filesOmitted) { text(details, 'h3', 'Changed files'); text(details, 'p', 'Too many changed files to list here. Use native Git to review this commit.').className = 'refs-note'; }
      else text(details, 'h3', `Changed files · ${value.files.length}`); showFiles(value.files, value.stats, `details:${value.commit.oid}:${value.parent || ''}`);
    }
    if (item.type === 'refs' && refsSlot && refsSlot.oid === item.oid && refsSlot.container.isConnected) showRefs(refsSlot.container, item.refs, item.refsError);
    if (item.type === 'comparison') {
      selected=-1;draw();for(const name of ['from','to']){const control=document.getElementById('compare').querySelector?.(`[name=${name}]`);if(control)control.value=item.inputs?.[name]??item.result[name];}
      const scope = `comparison:${item.result.from}:${item.result.to}`; if (scope !== comparisonScope) { comparisonScope = scope; comparisonExpanded = true; } workspace.className = comparisonExpanded ? 'split comparing' : 'split';
      details.replaceChildren(); const heading = text(details, 'h2', 'Compare revisions'); heading.setAttribute('tabindex', '-1'); heading.dataset.focusKey = 'comparison-heading'; const toolbar = document.createElement('div'), toggle = text(toolbar, 'button', comparisonExpanded ? 'Show History' : 'Expand Compare'); toolbar.className = 'details-toolbar'; toggle.dataset.focusKey = 'comparison-layout'; toggle.disabled = busy;
      toggle.addEventListener('click', () => { if (busy) return; comparisonExpanded = !comparisonExpanded; remember();workspace.className = comparisonExpanded ? 'split comparing' : 'split'; toggle.textContent = comparisonExpanded ? 'Show History' : 'Expand Compare'; if (comparisonExpanded) heading.focus(); else viewport.focus(); }); details.append(toolbar);
      const short = value => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(value)) ? String(value).slice(0, 8) : String(value), range = text(details, 'p', `${short(item.result.from)} → ${short(item.result.to)}`); range.title = `${item.result.from} → ${item.result.to}`;
      const sides = document.createElement('div'); sides.className = 'comparison-sides'; for (const [label, side] of [['Left only', 'left'], ['Right only', 'right']]) { const card = document.createElement('section'); card.className = 'comparison-side'; card.setAttribute('aria-label', label); sides.append(card); showSide(card, label, side, item.result[`${side}Commits`], item.result[`${side}Count`], item.result[`${side}Offset`]); } details.append(sides);
      text(details, 'h3', 'Changed files'); showFiles(item.result.files, item.result.stats, scope);
    }
    if (item.type === 'cancelled') { status.textContent = item.message; status.className = ''; }
    if (item.type === 'error') { status.textContent = item.message; status.className = 'error'; }
    if (item.type === 'busy') document.querySelectorAll('.refs-toggle').forEach(summary => summary.setAttribute('aria-disabled', String(item.busy)));
    if (item.type === 'busy') { if (item.busy && !busy) { const active = document.activeElement; focusBeforeBusy = active && typeof active.focus === 'function' ? { node: active, key: active.dataset?.focusKey } : undefined; } busy = item.busy; canCancel = busy && item.canCancel === true; viewport.setAttribute('aria-busy', String(busy)); document.querySelectorAll('button,input,select,textarea').forEach(control => { control.disabled = busy || control.dataset.available === 'false'; }); cancelRead.disabled = !canCancel; document.getElementById('more').disabled = busy || document.getElementById('more').dataset.available !== 'true'; if (busy) { status.textContent = 'Loading…'; status.className = ''; } else { if (status.textContent === 'Loading…') status.textContent = ''; restoreBusyFocus(); } }
  });
  showGuidance();
  send({ type: 'ready' });
})();
