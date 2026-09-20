export const TEST_STAGE_ID = 'e2e-interactive-state-reference';
export const SCENE_ID = 'scene-interactive-state';
export const IFRAME_TITLE = `Interactive Scene ${SCENE_ID}`;
const SETTINGS_STORAGE = JSON.stringify({
  state: {
    modelId: 'gpt-4o',
    providerId: 'openai',
    providersConfig: { openai: { apiKey: 'mock-only' } },
    agentMode: 'preset',
    selectedAgentIds: [],
    ttsEnabled: false,
    reviewOutlineEnabled: false,
    autoConfigApplied: true,
    sidebarCollapsed: false,
  },
  version: 2,
});

const INTERACTIVE_HTML = `<!doctype html><html><body><main id="experiment"><h1>Current-state activity</h1><input id="value" type="range" min="0" max="10" value="1"><label><input id="pause" type="checkbox">Pause render</label><button id="draw">Draw</button><p id="result"></p></main><script>
let value=1, revision=0;const graph=()=>({objects:[{id:'o',label:'Number',facts:[{key:'value',label:'Value',status:'known',value}]}],relations:{status:'complete',items:[]},missing:[]});
let rendered={status:'unknown',reason:'not yet'};
const node=document.createElement('script');node.type='application/json';node.setAttribute('data-maic-observation','');document.getElementById('experiment').appendChild(node);
function publish(){node.textContent=JSON.stringify({version:1,scope:{id:'experiment',label:'Activity'},current:{revision,updatedAt:Date.now(),graph:graph()},rendered});}
function draw(){document.getElementById('result').textContent=String(value);rendered={status:'known',basedOnRevision:revision,renderedAt:Date.now(),graph:graph()};publish();}
document.getElementById('value').oninput=e=>{value=Number(e.target.value);revision++;if(document.getElementById('pause').checked)publish();else draw();};document.getElementById('draw').onclick=draw;draw();
</script></body></html>`;

export async function seedDatabase(
  page: import('@playwright/test').Page,
  options: { html?: string; modelId?: string } = {},
) {
  const settings = JSON.parse(SETTINGS_STORAGE);
  if (options.modelId) settings.state.modelId = options.modelId;
  await page.addInitScript((settings) => {
    if (window.top !== window) return;
    localStorage.setItem('maic:account:settings-storage', settings);
  }, JSON.stringify(settings));

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ stageId, sceneId, html }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('maic-documents', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
        };
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
          const now = Date.now();
          tx.objectStore('stages').put({
            id: stageId,
            name: 'Interactive component reference',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
            dslVersion: '0.1.0',
          });
          tx.objectStore('scenes').put({
            id: sceneId,
            stageId,
            type: 'interactive',
            title: 'Slider experiment',
            order: 0,
            content: { type: 'interactive', url: '', html },
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('outlines').put({
            stageId,
            outline: { outlines: [], createdAt: now, updatedAt: now },
          });
          localStorage.setItem(
            `maic:device:editor-current-scene:${stageId}`,
            JSON.stringify({ sceneId, updatedAt: new Date(now).toISOString() }),
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { stageId: TEST_STAGE_ID, sceneId: SCENE_ID, html: options.html ?? INTERACTIVE_HTML },
  );
}
