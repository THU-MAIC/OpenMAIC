# SDD — Exportación LearnWorlds con Contenido Completo por Actividad (Revisión 2)

**Proyecto:** OpenMAIC · **Rama:** `feat/scorm-export` · **Fecha:** 14 de julio de 2026
**Antecedentes:** SDD "Exportación SCORM" y SDD "Integración LearnWorlds MCP" (en `docs/`).

## 1. Problema

La versión inicial de "Exportar a LearnWorlds" crea el curso y sus secciones vía MCP, pero las secciones quedan **vacías**: no aparecen las actividades con su contenido (páginas con diapositivas, cuestionarios, audios, actividades interactivas). El paquete SCORM descargado contiene todo el curso en una sola unidad monolítica, por lo que al subirlo se pierde la correspondencia clara entre actividades y contenido.

## 2. Restricción de plataforma (hallazgo del análisis)

Se auditó el spec OpenAPI completo del Learnworlds-MCP (`spec/learnworlds-openapi.yaml`, 94 herramientas). Las únicas operaciones de escritura sobre contenido de cursos son:

| Operación | Body aceptado |
| --- | --- |
| `POST /v2/courses` | `title`, `titleId`, `description`, `access`, `categories`, ... |
| `PUT /v2/courses/{id}` | Metadatos del curso |
| `POST /v2/courses/{id}/sections` | **Solo** `title`, `description`, `access`, `drip` (`SectionRequestModel`) |

> **No existe ningún endpoint en la API pública de LearnWorlds para crear learning units (ebook, video, audio, exam, SCORM, url...) dentro de una sección, ni para subir archivos.** El endpoint `GET /v2/courses/{id}/contents` confirma que las `learningUnits` solo son legibles. Esta es una limitación de LearnWorlds, no del MCP.

Por lo tanto, la única vía soportada por LearnWorlds para inyectar contenido ejecutable completo es la **unidad de aprendizaje tipo SCORM/HTML5**, que se sube manualmente desde el editor del curso (drag & drop del ZIP).

## 3. Solución de diseño: un paquete SCORM por actividad

Para que cada actividad aparezca de forma clara e individual en LearnWorlds, el flujo "Exportar a LearnWorlds" deja de generar un único SCORM monolítico y pasa a generar un **bundle con un mini-paquete SCORM 1.2 por cada escena/actividad**, numerados para mapear 1:1 con las secciones creadas vía MCP.

### 3.1 Estructura del bundle descargado

```
<Curso>.learnworlds.zip
├── LEEME.md                              ← guía de importación paso a paso
├── 01_Programacion_Asincronica.scorm.zip ← actividad 1 (página: slide+audio+transcripción)
├── 02_Artefactos_y_Contexto.scorm.zip    ← actividad 2
├── 03_Evaluacion_Context_Eng.scorm.zip   ← actividad 3 (quiz puntuable → cmi.core.score)
├── ...
└── 00_Curso_Completo.scorm.zip           ← paquete completo (opción alternativa)
```

Cada mini-paquete es un SCORM 1.2 single-SCO válido que reutiliza el player embebido existente con `course.json` restringido a esa única escena. Los quizzes reportan su nota individual al LMS (`cmi.core.score.raw`, `masteryscore`), lo que habilita el gradebook por actividad en LearnWorlds. El archivo `LEEME.md` indica a qué sección de LearnWorlds corresponde cada ZIP (mismo número/título que las secciones creadas por el MCP).

### 3.2 Ajustes al flujo de publicación MCP

1. `create_course` — sin cambios.
2. `create_course_section` — ahora la `description` de cada sección incluye el tipo de actividad y el nombre del archivo SCORM a subir (p. ej. *"Actividad: Cuestionario — subir 03_Evaluacion_Context_Eng.scorm.zip"*), para guiar la importación dentro del propio LearnWorlds.
3. Descarga del bundle `.learnworlds.zip` con los N+1 paquetes.
4. Toast final con enlace al administrador del curso y recuento de actividades generadas.

### 3.3 Refactor técnico

| Módulo | Cambio |
| --- | --- |
| `lib/export/scorm/scorm-core.ts` (nuevo) | Extrae de `use-export-scorm.ts` el pipeline puro `buildScormScenePayloads()` (snapshots, audio, inline de interactivas) y `assembleScormZip()` (player + manifest + data), parametrizado por subconjunto de escenas. Sin hooks ni estado de React. |
| `lib/export/scorm/use-export-scorm.ts` | Se reduce a orquestador del paquete completo usando el core (comportamiento del menú "Exportar SCORM" intacto). |
| `lib/lms/use-export-learnworlds.ts` | Publica curso+secciones (descripciones enriquecidas) y genera el bundle por actividad reutilizando los payloads del core una sola vez (snapshots/audio se calculan una vez y se comparten entre mini-paquetes). |
| `lib/lms/learnworlds-bundle.ts` (nuevo) | Ensambla el ZIP contenedor y el `LEEME.md`. |
| i18n | Claves nuevas del bundle y del LEEME en los 9 idiomas. |

### 3.4 Decisiones y alternativas descartadas

| Alternativa | Motivo de descarte |
| --- | --- |
| Crear learning units vía API | No existe endpoint (sección 2). |
| SCORM multi-SCO único (un `<item>` por escena en el manifest) | LearnWorlds importa el ZIP como **una sola** actividad SCORM; el índice multi-SCO no se refleja como actividades separadas del curso. Se conserva un solo paquete completo como opción, pero la vía principal es un ZIP por actividad. |
| Automatizar la subida del ZIP con browser automation | Frágil y fuera del alcance del MCP; se mantiene el paso manual guiado por el LEEME. |

## 4. Criterios de aceptación

1. "Exportar a LearnWorlds" crea el curso y las secciones con descripciones que referencian el archivo SCORM correspondiente.
2. Se descarga `<Curso>.learnworlds.zip` con un `NN_*.scorm.zip` por actividad + `00_Curso_Completo.scorm.zip` + `LEEME.md`.
3. Cada mini-paquete es SCORM 1.2 válido: manifest correcto, player funcional offline, slide con imagen+audio, quiz interactivo con puntuación reportada, interactiva con assets embebidos, PBL con resumen.
4. "Exportar SCORM" del menú (paquete completo) no cambia su comportamiento.
5. Tests existentes sin regresiones + tests nuevos del core y del bundle.
