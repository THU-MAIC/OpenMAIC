import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slide HTML on the `/api/persistence` document path, end to end: the real
 * route and owner-bound store on an in-memory PostgreSQL, with two browsers
 * that each hold their own anonymous identity.
 *
 * Document reads are capability-by-id, so the course link alone lets a viewer
 * load another owner's course, and the classroom renders slide text with
 * `dangerouslySetInnerHTML`. The store must therefore hold and return only
 * the renderer's HTML vocabulary, as `/api/classroom` does.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;

const PAYLOAD = '<img src=x onerror="alert(document.domain)">';
const BENIGN =
  '<p style="text-align: center;"><span style="color: #ff0000; font-size: 24px;">' +
  '<strong>Title</strong></span></p><ul><li><p>point <em>one</em></p></li></ul>';
/** {@link BENIGN} as the sanitizer serializes it: inline styles lose their spacing only. */
const BENIGN_SERIALIZED =
  '<p style="text-align:center"><span style="color:#ff0000;font-size:24px">' +
  '<strong>Title</strong></span></p><ul><li><p>point <em>one</em></p></li></ul>';

function slide(sceneId: string, stageId: string, text: string, order = 0) {
  return {
    id: sceneId,
    stageId,
    title: 'Welcome',
    order,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${sceneId}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#333333',
          fontName: 'Microsoft YaHei',
        },
        elements: [
          {
            id: `text-${sceneId}`,
            type: 'text',
            left: 0,
            top: 0,
            width: 800,
            height: 200,
            rotate: 0,
            defaultFontName: 'Microsoft YaHei',
            defaultColor: '#333333',
            content: text,
          },
          {
            id: `shape-${sceneId}`,
            type: 'shape',
            left: 0,
            top: 300,
            width: 200,
            height: 100,
            rotate: 0,
            viewBox: [200, 100],
            path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
            fixedRatio: false,
            fill: '#ffffff',
            text: {
              content: text,
              defaultFontName: 'Microsoft YaHei',
              defaultColor: '#333333',
              align: 'middle',
            },
          },
        ],
      },
    },
  };
}

function course(stageId: string, text: string) {
  return {
    stage: { id: stageId, name: 'Intro to Chemistry', createdAt: NOW, updatedAt: NOW },
    scenes: [slide('s1', stageId, text)],
    outline: {
      outlines: [],
      requirement: 'chemistry',
      generationComplete: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

type Scene = ReturnType<typeof slide>;

function slideHtml(scene: Scene): string[] {
  const [text, shape] = scene.content.canvas.elements as unknown as [
    { content: string },
    { text: { content: string } },
  ];
  return [text.content, shape.text.content];
}

describe('slide HTML on the persistence document path', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://scene-html-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function request(
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        method,
        headers: {
          cookie: `anonymous_id=${cookie}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { poolFactory: () => pool as never },
    );
  }

  async function storedScene(stageId: string, sceneId: string): Promise<Scene> {
    const { rows } = await pool.query(
      'SELECT data FROM document_scenes WHERE stage_id = $1 AND id = $2',
      [stageId, sceneId],
    );
    return (rows[0] as { data: Scene }).data;
  }

  it('stores a course without executable slide HTML, and serves another viewer none', async () => {
    const stageId = `poisoned-${randomUUID()}`;
    const put = await request(AUTHOR, 'PUT', `/documents/${stageId}`, course(stageId, PAYLOAD));
    expect(put.status).toBeLessThan(300);

    for (const html of slideHtml(await storedScene(stageId, 's1'))) {
      expect(html).not.toMatch(/onerror|<img/i);
    }

    // The shared course link: a different browser, capability-by-id read.
    const get = await request(VIEWER, 'GET', `/documents/${stageId}`);
    expect(get.status).toBe(200);
    const doc = (await get.json()) as { scenes: Scene[] };
    for (const html of slideHtml(doc.scenes[0]!)) {
      expect(html).not.toMatch(/onerror|<img/i);
    }
  });

  it('sanitizes a single-scene write', async () => {
    const stageId = `scene-write-${randomUUID()}`;
    expect(
      (await request(AUTHOR, 'PUT', `/documents/${stageId}`, course(stageId, BENIGN))).status,
    ).toBeLessThan(300);

    const put = await request(
      AUTHOR,
      'PUT',
      `/documents/${stageId}/scenes/s2`,
      slide('s2', stageId, `<p>ok</p>${PAYLOAD}<script>alert(1)</script>`, 1),
    );
    expect(put.status).toBeLessThan(300);

    for (const html of slideHtml(await storedScene(stageId, 's2'))) {
      expect(html).toBe('<p>ok</p>');
    }
  });

  it('sanitizes rows stored before writes were sanitized, on document and scene reads', async () => {
    const stageId = `legacy-${randomUUID()}`;
    expect(
      (await request(AUTHOR, 'PUT', `/documents/${stageId}`, course(stageId, BENIGN))).status,
    ).toBeLessThan(300);
    // What an earlier release could have stored: written past the store.
    await pool.query(
      'UPDATE document_scenes SET data = $3::jsonb WHERE stage_id = $1 AND id = $2',
      [stageId, 's1', JSON.stringify(slide('s1', stageId, PAYLOAD))],
    );

    const doc = (await (await request(VIEWER, 'GET', `/documents/${stageId}`)).json()) as {
      scenes: Scene[];
    };
    for (const html of slideHtml(doc.scenes[0]!)) {
      expect(html).not.toMatch(/onerror|<img/i);
    }

    const scene = await request(VIEWER, 'GET', `/documents/${stageId}/scenes/s1`);
    expect(scene.status).toBe(200);
    for (const html of slideHtml((await scene.json()) as Scene)) {
      expect(html).not.toMatch(/onerror|<img/i);
    }
  });

  it('keeps editor formatting, and a second save of what it serves changes nothing', async () => {
    const stageId = `benign-${randomUUID()}`;
    expect(
      (await request(AUTHOR, 'PUT', `/documents/${stageId}`, course(stageId, BENIGN))).status,
    ).toBeLessThan(300);

    for (const html of slideHtml(await storedScene(stageId, 's1'))) {
      expect(html).toBe(BENIGN_SERIALIZED);
    }
    const served = (await (await request(AUTHOR, 'GET', `/documents/${stageId}`)).json()) as {
      stage: unknown;
      scenes: Scene[];
      outline: unknown;
    };
    for (const html of slideHtml(served.scenes[0]!)) {
      expect(html).toBe(BENIGN_SERIALIZED);
    }

    expect((await request(AUTHOR, 'PUT', `/documents/${stageId}`, served)).status).toBeLessThan(
      300,
    );
    expect(await storedScene(stageId, 's1')).toEqual(served.scenes[0]);
  });
});
