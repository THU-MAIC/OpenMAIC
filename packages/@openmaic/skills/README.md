# @openmaic/skills

Server-side Agent Skills directory packages. `SkillPackage` validates `SKILL.md`
frontmatter and snapshots every file, including references, assets, and opaque
resources. Revisions cover sorted paths and exact bytes, independent of ZIP
metadata. Scripts are stored as data; this library never executes files.

`importSkillPackage` and `exportSkillPackage` round-trip a single named directory.
Imports bound actual decompression and reject unsafe paths and special files.
Path components and the package root must also be portable to Windows: reserved
device names, invalid filename characters, and trailing dots or spaces are rejected.
Exceeding a resource limit, including the number of archived files, reports
`LIMIT_EXCEEDED`.
`patchSkillPackage` returns a new package; persistence adapters must additionally
compare the expected revision atomically when committing. Authorization and
retention of referenced revisions belong to the consuming application.

`skillPackageFromLegacyContent` adapts existing name/description/title/content records to a single-file package without requiring a storage migration. Multi-file persistence remains the responsibility of the consuming store.
