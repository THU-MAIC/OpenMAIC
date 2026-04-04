export interface ScoEntry {
  id: string;     // e.g. "scene_01"
  title: string;
  href: string;   // e.g. "scos/scene_01.html"
  isQuiz: boolean;
  assetHrefs: string[]; // all asset paths referenced by this SCO
}

const PASS_SCORE = 80;

/**
 * Builds the imsmanifest.xml string for a SCORM 1.2 package.
 */
export function buildManifest(
  courseId: string,
  courseTitle: string,
  scos: ScoEntry[],
): string {
  const escXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const orgId = `${courseId}_org`;

  const items = scos
    .map(
      (sco) => `
      <item identifier="item_${sco.id}" identifierref="res_${sco.id}">
        <title>${escXml(sco.title)}</title>${sco.isQuiz ? `\n        <adlcp:masteryscore>${PASS_SCORE}</adlcp:masteryscore>` : ''}
      </item>`,
    )
    .join('');

  const resources = scos
    .map((sco) => {
      const files = [`<file href="${escXml(sco.href)}"/>`, `<file href="scorm_bridge.js"/>`];
      for (const asset of sco.assetHrefs) {
        files.push(`<file href="${escXml(asset)}"/>`);
      }
      return `
    <resource identifier="res_${sco.id}"
              type="webcontent"
              adlcp:scormtype="sco"
              href="${escXml(sco.href)}">
      ${files.join('\n      ')}
    </resource>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escXml(courseId)}"
  version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">

  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>

  <organizations default="${escXml(orgId)}">
    <organization identifier="${escXml(orgId)}">
      <title>${escXml(courseTitle)}</title>${items}
    </organization>
  </organizations>

  <resources>${resources}
  </resources>

</manifest>`;
}
