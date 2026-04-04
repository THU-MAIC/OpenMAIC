export interface ScormManifestOptions {
  courseId: string;
  courseTitle: string;
  /** All asset zip paths referenced by the single SCO */
  assetHrefs: string[];
  /** Pass threshold (0-100). Set only if course has quiz scenes. */
  masteryScore?: number;
}

/**
 * Builds the imsmanifest.xml string for a single-SCO SCORM 1.2 package.
 * All course content lives in one index.html file at the package root.
 */
export function buildManifest(opts: ScormManifestOptions): string {
  const { courseId, courseTitle, assetHrefs, masteryScore } = opts;

  const escXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const orgId = `${courseId}_org`;

  const masteryLine =
    masteryScore !== undefined
      ? `\n        <adlcp:masteryscore>${masteryScore}</adlcp:masteryscore>`
      : '';

  const fileEntries = [
    `<file href="index.html"/>`,
    `<file href="scorm_bridge.js"/>`,
    ...assetHrefs.map((h) => `<file href="${escXml(h)}"/>`),
  ].join('\n      ');

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
      <title>${escXml(courseTitle)}</title>
      <item identifier="item_1" identifierref="res_1">
        <title>${escXml(courseTitle)}</title>${masteryLine}
      </item>
    </organization>
  </organizations>

  <resources>
    <resource identifier="res_1"
              type="webcontent"
              adlcp:scormtype="sco"
              href="index.html">
      ${fileEntries}
    </resource>
  </resources>

</manifest>`;
}
