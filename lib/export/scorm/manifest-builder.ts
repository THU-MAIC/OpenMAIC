/**
 * SCORM manifest builder.
 *
 * Generates `imsmanifest.xml` for SCORM 1.2 or SCORM 2004 (4th ed.).
 * We package the course as a single SCO (one entry point, `index.html`).
 * Each course module is represented as an `<item>` in the organization,
 * but all items point to the same SCO resource — the player handles internal
 * navigation via hash fragments (`index.html#module/0` style).
 */
import { create } from 'xmlbuilder2';

export type ScormVersion = '1.2' | '2004';

export interface ManifestOptions {
  courseId: string;
  courseTitle: string;
  courseDescription?: string;
  language?: string;
  version: ScormVersion;
  /** All files that will end up in the zip, relative paths with forward slashes */
  resourceFiles: string[];
  /** Modules to list as navigation items inside the organization */
  modules: Array<{ id: string; title: string }>;
}

export function buildManifest(opts: ManifestOptions): string {
  return opts.version === '1.2' ? buildScorm12Manifest(opts) : buildScorm2004Manifest(opts);
}

function buildScorm12Manifest(opts: ManifestOptions): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('manifest', {
    identifier: `OPENMAIC-${opts.courseId}`,
    version: '1.0',
    'xmlns': 'http://www.imsproject.org/xsd/imscp_rootv1p1p2',
    'xmlns:adlcp': 'http://www.adlnet.org/xsd/adlcp_rootv1p2',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation':
      'http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd ' +
      'http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd ' +
      'http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd',
  });

  // Metadata
  const metadata = doc.ele('metadata');
  metadata.ele('schema').txt('ADL SCORM');
  metadata.ele('schemaversion').txt('1.2');

  // Organizations
  const organizations = doc.ele('organizations', { default: `ORG-${opts.courseId}` });
  const org = organizations.ele('organization', { identifier: `ORG-${opts.courseId}` });
  org.ele('title').txt(opts.courseTitle);

  // One top-level item per module, all pointing at the same resource but with a parameter
  if (opts.modules.length === 0) {
    org
      .ele('item', {
        identifier: `ITEM-${opts.courseId}`,
        identifierref: `RES-${opts.courseId}`,
      })
      .ele('title')
      .txt(opts.courseTitle);
  } else {
    opts.modules.forEach((mod, idx) => {
      org
        .ele('item', {
          identifier: `ITEM-${mod.id}`,
          identifierref: `RES-${opts.courseId}`,
          parameters: `?module=${idx}`,
        })
        .ele('title')
        .txt(mod.title);
    });
  }

  // Resources
  const resources = doc.ele('resources');
  const resource = resources.ele('resource', {
    identifier: `RES-${opts.courseId}`,
    type: 'webcontent',
    'adlcp:scormtype': 'sco',
    href: 'index.html',
  });
  for (const file of opts.resourceFiles) {
    resource.ele('file', { href: file });
  }

  return doc.end({ prettyPrint: true });
}

function buildScorm2004Manifest(opts: ManifestOptions): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('manifest', {
    identifier: `OPENMAIC-${opts.courseId}`,
    version: '1.0',
    'xmlns': 'http://www.imsglobal.org/xsd/imscp_v1p1',
    'xmlns:adlcp': 'http://www.adlnet.org/xsd/adlcp_v1p3',
    'xmlns:adlseq': 'http://www.adlnet.org/xsd/adlseq_v1p3',
    'xmlns:adlnav': 'http://www.adlnet.org/xsd/adlnav_v1p3',
    'xmlns:imsss': 'http://www.imsglobal.org/xsd/imsss',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation':
      'http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd ' +
      'http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd ' +
      'http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd ' +
      'http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd ' +
      'http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd',
  });

  doc.att('xml:base', '');

  // Metadata
  const metadata = doc.ele('metadata');
  metadata.ele('schema').txt('ADL SCORM');
  metadata.ele('schemaversion').txt('2004 4th Edition');

  // Organizations
  const organizations = doc.ele('organizations', { default: `ORG-${opts.courseId}` });
  const org = organizations.ele('organization', { identifier: `ORG-${opts.courseId}` });
  org.ele('title').txt(opts.courseTitle);

  if (opts.modules.length === 0) {
    org
      .ele('item', {
        identifier: `ITEM-${opts.courseId}`,
        identifierref: `RES-${opts.courseId}`,
      })
      .ele('title')
      .txt(opts.courseTitle);
  } else {
    opts.modules.forEach((mod, idx) => {
      org
        .ele('item', {
          identifier: `ITEM-${mod.id}`,
          identifierref: `RES-${opts.courseId}`,
          parameters: `?module=${idx}`,
        })
        .ele('title')
        .txt(mod.title);
    });
  }

  // Resources
  const resources = doc.ele('resources');
  const resource = resources.ele('resource', {
    identifier: `RES-${opts.courseId}`,
    type: 'webcontent',
    'adlcp:scormType': 'sco',
    href: 'index.html',
  });
  for (const file of opts.resourceFiles) {
    resource.ele('file', { href: file });
  }

  return doc.end({ prettyPrint: true });
}
