import { seedServerDocument, setCurrentScene, uniqueStageId } from './server-seed';

/** Prefix of the seeded course id; each seed appends a unique suffix. */
export const TEST_STAGE_PREFIX = 'e2e-interactive-state-reference';
export const SCENE_ID = 'scene-interactive-state';
export const IFRAME_TITLE = `Interactive Scene ${SCENE_ID}`;
const SETTINGS_STORAGE = JSON.stringify({
  state: {
    agentMode: 'preset',
    selectedAgentIds: [],
    reviewOutlineEnabled: false,
    sidebarCollapsed: false,
  },
  version: 5,
});

const INTERACTIVE_HTML = `<!doctype html><html><body><main id="experiment"><h1>Current-state activity</h1><input id="value" type="range" min="0" max="10" value="1"><label><input id="pause" type="checkbox">Pause render</label><button id="draw">Draw</button><p id="result"></p></main><script>
let value=1, revision=0;const graph=()=>({objects:[{id:'o',label:'Number',facts:[{key:'value',label:'Value',status:'known',value}]}],relations:{status:'complete',items:[]},missing:[]});
let rendered={status:'unknown',reason:'not yet'};
const node=document.createElement('script');node.type='application/json';node.setAttribute('data-maic-observation','');document.getElementById('experiment').appendChild(node);
function publish(){node.textContent=JSON.stringify({version:1,scope:{id:'experiment',label:'Activity'},current:{revision,updatedAt:Date.now(),graph:graph()},rendered});}
function draw(){document.getElementById('result').textContent=String(value);rendered={status:'known',basedOnRevision:revision,renderedAt:Date.now(),graph:graph()};publish();}
document.getElementById('value').oninput=e=>{value=Number(e.target.value);revision++;if(document.getElementById('pause').checked)publish();else draw();};document.getElementById('draw').onclick=draw;draw();
</script></body></html>`;

/**
 * Seed the interactive course as this page's owner and return its id. Course
 * ids are global on the server and another owner's id cannot be written, so
 * every seed gets a fresh one.
 */
export async function seedDatabase(
  page: import('@playwright/test').Page,
  options: {
    html?: string;
    modelId?: string;
    whiteboard?: import('@openmaic/dsl').Whiteboard[];
  } = {},
): Promise<string> {
  const stageId = uniqueStageId(TEST_STAGE_PREFIX);
  const settings = JSON.parse(SETTINGS_STORAGE);
  if (options.modelId) settings.state.modelId = options.modelId;
  await page.addInitScript((settings) => {
    if (window.top !== window) return;
    localStorage.setItem('maic:account:settings-storage', settings);
  }, JSON.stringify(settings));

  await page.goto('/', { waitUntil: 'networkidle' });
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Interactive component reference',
      ...(options.whiteboard ? { whiteboard: options.whiteboard } : {}),
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: SCENE_ID,
        stageId,
        type: 'interactive',
        title: 'Slider experiment',
        order: 0,
        content: { type: 'interactive', url: '', html: options.html ?? INTERACTIVE_HTML },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  await setCurrentScene(page, stageId, SCENE_ID);
  return stageId;
}
