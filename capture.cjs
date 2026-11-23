const { chromium, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const origin = new URL(process.argv[2] || 'http://127.0.0.1:3000').origin;
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Use a loopback server.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-example-'));
const output = path.join(__dirname, 'voice-draft.mp4');
const wave = path.join(scratch, 'sample.wav');
const webm = path.join(scratch, 'viewport.webm');
const draft = 'My next step is to';
const effective = {status: 'assigned', registryId: 'openai-whisper', modelId: 'whisper-1', providerId: 'local-asr'};
const view = {
  id: 'voice-example', revision: 1, onboardingCompleted: true, title: 'Greeting',
  environmentId: 'example-environment', environment: {state: 'running', ready: true},
  state: {
    status: 'running', position: {milestoneIndex: 0, milestoneId: 'greeting', stageIndex: 0},
    milestones: [], collected: {}, decisionRevisions: {}, lastSequence: 1,
  },
  milestones: [{id: 'greeting', title: 'Greeting', stages: ['dialogue']}],
  stage: {kind: 'mentor_say', agent: 'discussion', say: 'Hello', reads: [], studentActions: ['chat']},
  role: 'discussion', actions: ['chat'], files: ['PLAN.md', 'greeting.py'], conversation: [], messages: [],
  busy: false, needsOpening: false, reportAvailable: false, roleRun: null,
  decisions: [], questions: [], evaluation: null,
};
const workbench = {environmentId: view.environmentId, revision: 1, epoch: 0, canEdit: false, canManageFiles: false, canRun: false, planning: false, commands: [], terminals: []};

async function main() {
  const aiff = path.join(scratch, 'sample.aiff');
  execFileSync('say', ['-v', 'Samantha', '-r', '145', '-o', aiff, 'read the file']);
  execFileSync('ffmpeg', ['-loglevel','error','-i',aiff,'-ac','1','-ar','48000','-af','adelay=650,apad=pad_dur=0.8',wave]);
  const stream = require('node:http').createServer((request,response) => {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-headers', 'x-openmaic-sandbox');
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    response.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-store'});
    const send = () => response.write('event: learning\ndata: '+JSON.stringify({view,workbench})+'\n\n');
    send();const timer = setInterval(send, 4000);response.once('close',()=>clearInterval(timer));
  });
  await new Promise(resolve=>stream.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({args: [
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture=' + wave + '%noloop',
  ]});
  try {
    const page = await browser.newPage({
      locale: 'en-US', viewport: {width: 1200, height: 750}, permissions: ['microphone'],
      serviceWorkers: 'block',
    });
    await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
    let transcript = '';
    let messagesSent = 0;
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/model-config') return route.fulfill({json: {revision: 0, providers: [], catalog: [], slots: [{slot: 'asr', effective}]}});
      if (url.pathname === '/api/pbl/v3/events') return route.continue({url:'http://127.0.0.1:'+stream.address().port+'/events'});
      if (url.pathname === '/api/pbl/v3/workspace') return route.fulfill({json: workbench});
      if (url.pathname === '/api/pbl/v3') {
        if (request.method() === 'POST' && request.postDataJSON()?.command?.type === 'chat') messagesSent++;
        return route.fulfill({json: url.searchParams.has('file') ? {text: '', hash: 'a'.repeat(64)} : view});
      }
      if (url.pathname === '/api/transcription') {
        const form = await new Response(request.postDataBuffer(), {headers: {'content-type':request.headers()['content-type']}}).formData();
        const audio = form.get('audio');
        if (!audio || audio.size < 1500) throw new Error('No microphone recording.');
        transcript = execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'recognize.py')], {input: Buffer.from(await audio.arrayBuffer()), encoding:'utf8'}).trim();
        return route.fulfill({json: {text: transcript}});
      }
      return route.fulfill({json: {}});
    });
    await page.goto(origin+'/review-voice', {waitUntil:'domcontentloaded',timeout:120000});
    const input = page.getByRole('textbox', {name:'Your message'});
    const mic = page.getByRole('button', {name:'Voice input', exact:true});
    await input.fill(draft, {timeout:90000});
    await expect(mic).toBeEnabled({timeout:30000});
    const headers = await page.locator('.pbl-pane-header:visible').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      return {text:node.textContent, y:r.y, height:r.height, bottom:r.bottom};
    }));
    const row = headers.filter(header => header.height === 36);
    if (row.length < 3 || !row.slice(0,3).every(header => header.bottom === row[0].bottom)) throw new Error('Pane headers did not align.');
    await page.screenshot({path:path.join(__dirname,'pane-headers.png'),clip:{x:0,y:row[0].y-4,width:1200,height:48},scale:'css'});
    const box = await input.locator('..').boundingBox();
    const x = Math.floor(box.x/2)*2-2, y = Math.floor(box.y/2)*2-2;
    const w = Math.min(1200-x, Math.ceil((box.x+box.width-x+2)/2)*2);
    const h = Math.min(750-y, Math.ceil((box.y+box.height-y+2)/2)*2);
    await page.screencast.start({path:webm,size:{width:1200,height:750}});
    await page.waitForTimeout(850);
    await mic.click();
    const stop = page.getByRole('button', {name:'Stop recording',exact:true});
    await expect(stop).toBeVisible();
    await page.waitForTimeout(3350);
    await stop.click();
    await expect.poll(()=>transcript,{timeout:15000}).toBe('read the file');
    await expect(input).toHaveValue(draft+' '+transcript);
    if (messagesSent !== 0) throw new Error('The draft was sent.');
    await stop.or(mic).evaluate(el=>el.blur());
    await page.mouse.move(50,50);
    await page.waitForTimeout(1600);
    await page.screencast.stop();
    execFileSync('ffmpeg',['-y','-loglevel','error','-i',webm,'-vf',`crop=${w}:${h}:${x}:${y},fps=10`,'-an','-map_metadata','-1','-c:v','libx264','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',output]);
    console.log(JSON.stringify({draft,transcript,messagesSent,w,h}));
  } finally {
    await browser.close();
    stream.closeAllConnections();
    await new Promise(resolve=>stream.close(resolve));
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
