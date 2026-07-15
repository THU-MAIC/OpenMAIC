// lib/export/scorm/scorm-manifest.ts
//
// SCORM 1.2 `imsmanifest.xml` generator.
//
// The package is modeled as a single SCO (the embedded player `index.html`)
// so sequencing stays inside the player and any SCORM 1.2 compliant LMS can
// launch it. Multi-SCO organizations were considered and rejected: interactive
// and PBL scenes share media/data with slide scenes, so one SCO keeps the
// package self-contained and avoids LMS-specific sequencing quirks.

import type { ScormManifestOptions } from './scorm-types';

/** Escape a string for safe inclusion in XML text/attribute positions. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the SCORM 1.2 `imsmanifest.xml` content.
 *
 * Schema references follow the ADL SCORM 1.2 Content Aggregation Model. The
 * XSD companion files (`imscp_rootv1p1p2.xsd` etc.) are intentionally not
 * bundled — every mainstream LMS (Moodle, SCORM Cloud, Blackboard, Canvas)
 * validates without them, and omitting them keeps the package lean.
 */
export function buildImsManifest(options: ScormManifestOptions): string {
  const { identifier, title, description, resourceFiles, masteryScore } = options;

  const fileEntries = resourceFiles
    .map((path) => `        <file href="${escapeXml(path)}" />`)
    .join('\n');

  const descriptionBlock = description
    ? `\n      <description>${escapeXml(description)}</description>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeXml(identifier)}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                      http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd
                      http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-openmaic">
    <organization identifier="ORG-openmaic">
      <title>${escapeXml(title)}</title>
      <item identifier="ITEM-course" identifierref="RES-course" isvisible="true">
        <title>${escapeXml(title)}</title>
        <adlcp:masteryscore>${masteryScore}</adlcp:masteryscore>
      </item>${descriptionBlock}
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-course" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileEntries}
    </resource>
  </resources>
</manifest>
`;
}
