const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

(async () => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'git-pro-host-'));
  const projectRoot = await fs.realpath(path.resolve(__dirname, '..'));
  const extensionRoot = path.join(projectRoot, `.test-host-extensions-${randomUUID()}`);
  let extensionRootOwned = false;
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, '[user]\n name = Fixture\n email = fixture@example.invalid\n[commit]\n gpgsign = false\n');
  const git = args => {
    const result = spawnSync('git', args, { cwd: workspace, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(['init', '-b', 'main']); await fs.writeFile(path.join(workspace, 'changed.txt'), 'hello');
  // Prepare config before the built-in Git host starts its background reads.
  const remote = path.join(root, 'remote.git'); await fs.mkdir(remote);
  const bare = spawnSync('git', ['init', '--bare'], { cwd: remote, env, encoding: 'utf8', windowsHide: true });
  if (bare.status !== 0) throw new Error(bare.stderr);
  git(['remote', 'add', 'origin', remote]);
  const launchArgs = [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-extension', 'github.copilot', '--disable-extension', 'github.copilot-chat',
    '--user-data-dir', path.join(root, 'profile'), '--extensions-dir', extensionRoot];
  if (process.platform === 'linux') launchArgs.push('--no-sandbox');
  try {
    await fs.mkdir(extensionRoot); extensionRootOwned = true;
    let extensionPath=path.resolve(__dirname,'..');let executable=process.env.GIT_PRO_TEST_EXECUTABLE;
    if(process.env.GIT_PRO_TEST_VSIX){
      executable=executable||await downloadAndUnzipVSCode(process.env.GIT_PRO_TEST_VERSION||'1.100.0');
      let cliJs=process.platform==='darwin'?path.resolve(path.dirname(executable),'../Resources/app/out/cli.js'):path.join(path.dirname(executable),'resources','app','out','cli.js');
      if(process.platform==='win32'){
        const cliFile=path.join(path.dirname(executable),'bin','code.cmd'),source=await fs.readFile(cliFile,'utf8');
        const match=/"%~dp0([^"\r\n]*\\resources\\app\\out\\cli\.js)"/.exec(source);
        if(!match)throw new Error('Bundled CLI module path is unavailable.');
        cliJs=path.resolve(path.dirname(cliFile),match[1]);
        if(!cliJs.startsWith(path.dirname(executable)+path.sep))throw new Error('Bundled CLI path escapes the downloaded host.');
      }
      // Newer hosts have application-shared storage beyond user-data-dir. Use
      // their supported CLI option to keep it inside the owned test profile.
      const sharedArgs=(await fs.readFile(cliJs,'utf8')).includes('shared-data-dir')?['--shared-data-dir',path.join(root,'shared-data')]:[];
      launchArgs.push(...sharedArgs);
      const installed=spawnSync(executable,[cliJs,'--install-extension',path.resolve(process.env.GIT_PRO_TEST_VSIX),'--extensions-dir',extensionRoot,'--user-data-dir',path.join(root,'profile'),...sharedArgs],{env:{...env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,shell:false,encoding:'utf8',timeout:60_000});
      if(installed.status!==0)throw new Error(`Private VSIX installation failed: ${installed.stderr}`);
      extensionPath=path.join(extensionRoot,'nhech.git-pro-0.1.0');
      for(const asset of ['dist/extension.js','media/helpers/rebase-editor.cjs','media/helpers/preserve-editor.cjs','package.nls.json'])await fs.access(path.join(extensionPath,asset));
      console.log('Private VSIX installed in an isolated temporary profile; testing packaged extension assets.');
    }
    const restart=process.env.GIT_PRO_TEST_RESTART==='1';let fixturePath;
    if(restart){
      fixturePath=path.join(root,'restart-fixture-extension');await fs.mkdir(fixturePath);
      await fs.writeFile(path.join(fixturePath,'package.json'),JSON.stringify({name:'restart-journal',publisher:'git-pro-fixture',version:'0.0.0',private:true,license:'UNLICENSED',engines:{vscode:'^1.100.0'},main:'./index.cjs',activationEvents:['onStartupFinished']}));
      const runner=path.resolve(__dirname,'..','.test-build','test','extension','restart.js');
      const fixtureSource=`const fs=require('node:fs/promises');const path=require('node:path');const vscode=require('vscode');\nexports.activate=context=>{setTimeout(async()=>{let result;try{await require(${JSON.stringify(runner)}).run();result={passed:true,stage:process.env.GIT_PRO_TEST_RESTART_STAGE,pid:process.pid};}catch(error){result={passed:false,stage:process.env.GIT_PRO_TEST_RESTART_STAGE,error:String(error)};}await fs.writeFile(path.join(${JSON.stringify(root)},'restart-'+process.env.GIT_PRO_TEST_RESTART_STAGE+'.json'),JSON.stringify(result));await vscode.commands.executeCommand('workbench.action.quit');},0);return {state:context.workspaceState,storage:context.globalStorageUri.fsPath};};\n`;
      await fs.writeFile(path.join(fixturePath,'index.cjs'),fixtureSource);
    }
    const options={ version: process.env.GIT_PRO_TEST_VERSION || '1.100.0',
      ...(executable ? { vscodeExecutablePath: executable } : {}),
      extensionDevelopmentPath: restart?[extensionPath,fixturePath]:extensionPath,
      extensionTestsPath: path.resolve(__dirname, '..', '.test-build', 'test', 'extension', restart?'restart.js':'index.js'),
      extensionTestsEnv: env, launchArgs };
    if(restart){
      // Extension test mode deliberately stores Memento in memory. Use a normal,
      // isolated development window and public fixture API, never private DB access.
      executable=executable||await downloadAndUnzipVSCode(process.env.GIT_PRO_TEST_VERSION||'1.100.0');
      for(const stage of ['seed','resume']){
        const args=[...launchArgs,'--new-window','--disable-updates',`--extensionDevelopmentPath=${extensionPath}`,`--extensionDevelopmentPath=${fixturePath}`];
        await new Promise((resolve,reject)=>{
          const child=spawn(executable,args,{env:{...env,GIT_PRO_TEST_RESTART_STAGE:stage},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
          child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));
          const timer=setTimeout(()=>{
            if(child.exitCode===null&&child.pid){if(process.platform==='win32')spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,timeout:10_000});else child.kill('SIGTERM');}
            reject(new Error(`Owned restart fixture ${stage} exceeded 60 seconds.`));
          },60_000);
          child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`Restart development window exited ${code}.`));});
        });
        const result=JSON.parse(await fs.readFile(path.join(root,`restart-${stage}.json`),'utf8'));if(!result.passed)throw new Error(`Restart ${stage} failed: ${result.error}`);console.log(JSON.stringify(result));
      }
      console.log('Two VS Code processes passed persisted public-Memento rebase recovery. Git Pro UI restart remains a separate manual gate.');
    }else await runTests(options);
  } finally {
    if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith('git-pro-host-')) throw new Error('Unsafe host cleanup.');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    if (extensionRootOwned) {
      if (path.dirname(extensionRoot) !== projectRoot || !path.basename(extensionRoot).startsWith('.test-host-extensions-')) throw new Error('Unsafe installed-extension cleanup.');
      await fs.rm(extensionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
