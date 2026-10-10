export function commitHtml(resources: { session: string; nonce: string; style: string; icons?: string; script: string; cspSource: string }): string {
  const { session, nonce, style, icons, script, cspSource } = resources;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-${nonce}';">${icons ? `<link rel="stylesheet" href="${icons}">` : ''}<link rel="stylesheet" href="${style}"></head>
<body data-session="${session}">
<label for="message" class="sr-only">Commit message</label><textarea id="message" rows="1" placeholder="Message (Ctrl+Enter to commit)" maxlength="65536" aria-describedby="warning stagingHelp"></textarea>
<p id="warning" aria-live="polite"></p>
<div class="actions"><button id="commit"><span class="codicon codicon-check" aria-hidden="true"></span><span id="commit-label">Commit</span></button><details id="commit-menu" class="split-menu"><summary class="split-toggle" title="More Actions…"><span class="codicon codicon-chevron-down" aria-hidden="true"></span><span id="advanced-label" class="sr-only">Advanced options</span></summary><div class="menu" role="group" aria-label="Commit options"><button id="push" type="button" class="menu-item"><span class="codicon codicon-cloud-upload" aria-hidden="true"></span><span>Commit &amp; Push</span></button><div class="menu-separator" role="separator"></div><label class="menu-check"><input type="checkbox" id="amend">Amend staged changes</label><label class="menu-check"><input type="checkbox" id="signoff">Sign-off</label><label class="menu-check"><input type="checkbox" id="noVerify">Skip hooks</label><div class="menu-separator" role="separator"></div><label for="history" class="menu-label">Message history</label><select id="history"><option value="">Choose previous message…</option></select><button id="clearHistory" type="button" class="menu-link">Clear message history</button></div></details></div>
<p id="option-flags" class="option-flags" hidden></p>
<div class="context"><p id="repository">Choose a repository</p><p id="staged" aria-live="polite"></p></div>
<p id="result" role="status"></p>
<p id="stagingHelp" class="helper">Selection does not stage files. Use Stage Selected in Changes. Partial staging opens native Source Control.</p>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}
