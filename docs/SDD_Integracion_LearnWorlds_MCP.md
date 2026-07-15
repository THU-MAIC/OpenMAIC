# Especificación de Diseño de Software (SDD)
## Integración LearnWorlds MCP en OpenMAIC

**Autor:** Manus AI
**Fecha:** 15 de julio de 2026
**Proyecto:** OpenMAIC

Este documento describe la arquitectura y diseño para integrar el servidor [Learnworlds-MCP](https://github.com/ohneben/Learnworlds-MCP) en OpenMAIC. La integración permite configurar las credenciales del MCP en la aplicación y exportar la estructura de los cursos directamente a un LMS LearnWorlds.

### 1. Arquitectura de Configuración

La configuración del servidor MCP se integrará en el sistema de ajustes existente (`SettingsDialog`) y se almacenará en el `settings-storage` persistente de Zustand.

**Almacenamiento de Estado (Zustand)**
Se extenderá la interfaz `SettingsState` en `lib/store/settings.ts` para incluir la configuración de integraciones LMS:

```typescript
export interface LmsMcpConfig {
  enabled: boolean;
  transport: 'stdio' | 'http';
  // stdio settings
  command?: string;
  args?: string[];
  // http settings
  httpUrl?: string;
  httpAuthToken?: string;
  // learnworlds environment
  baseUrl: string;
  apiToken: string;
  clientId: string;
}

export interface SettingsState {
  // ... existing fields ...
  lmsConfig: LmsMcpConfig;
  setLmsConfig: (config: Partial<LmsMcpConfig>) => void;
}
```

**Interfaz de Usuario (SettingsDialog)**
Se añadirá una nueva sección `lms` al tipo `SettingsSection`. El panel `LmsSettings` permitirá al usuario ingresar la configuración manualmente o pegar directamente el bloque JSON del archivo de configuración de Claude Desktop (analizando `mcpServers.learnworlds`). El panel incluirá un botón "Probar Conexión" que invocará una ruta API para listar las herramientas del MCP y verificar las credenciales.

### 2. Cliente MCP en Backend (Ruta API)

Dado que el navegador no puede invocar procesos `stdio` ni realizar conexiones TCP directas sin CORS, la comunicación con el servidor MCP se realizará a través de una ruta API en Next.js.

Se creará el archivo `app/api/lms/learnworlds/route.ts`. Esta ruta utilizará el `@modelcontextprotocol/sdk` (versión ^1.27.1, ya presente en el proyecto) para inicializar el cliente MCP bajo demanda.

Dependiendo del transporte configurado:
- Si es `stdio`: Utilizará `StdioClientTransport` ejecutando el comando configurado (ej. `node`) con sus argumentos y las variables de entorno inyectadas (`LEARNWORLDS_BASE_URL`, `LEARNWORLDS_API_TOKEN`, `LEARNWORLDS_CLIENT_ID`).
- Si es `http`: Utilizará `StreamableHTTPClientTransport` hacia la URL proporcionada.

### 3. Flujo de Exportación y Publicación

El menú de exportación en `components/stage/header-controls.tsx` incluirá una nueva opción "Exportar a LearnWorlds". Esta opción orquestará el siguiente flujo:

1. **Generación del Paquete SCORM:** Reutilizará el hook `useExportScorm` para generar el archivo ZIP con todo el contenido del curso (imágenes, audios, cuestionarios).
2. **Publicación de Estructura (Vía MCP):**
   - El cliente invocará la ruta API de LearnWorlds, pasando los metadatos del curso y las secciones.
   - La ruta API conectará al MCP y ejecutará la herramienta `create_course` para crear el curso en estado `draft`.
   - Luego, iterará sobre las escenas del curso y ejecutará `create_course_section` para replicar la estructura en el LMS.
3. **Descarga y Feedback:** Dado que la API pública de LearnWorlds (y por ende el MCP) no expone un endpoint para subir archivos SCORM, el flujo descargará el archivo ZIP SCORM generado localmente y presentará un cuadro de diálogo de éxito. Este cuadro incluirá un enlace directo al panel de administración del curso recién creado en LearnWorlds, con instrucciones claras indicando al usuario que debe subir el archivo ZIP descargado a la unidad SCORM correspondiente.

### 4. Internacionalización (i18n)

Se añadirán las siguientes claves a los archivos de localización (ej. `es-ES.json`):
- `settings.lmsIntegration`: "Integración LMS"
- `settings.learnworldsMcp`: "LearnWorlds MCP"
- `export.learnworlds`: "Exportar a LearnWorlds"
- `export.learnworldsDesc`: "Publica la estructura del curso y descarga el SCORM"
- Mensajes de estado y validación de conexión.

### 5. Consideraciones de Seguridad

Las credenciales del LMS (API tokens, Client IDs) se almacenarán exclusivamente en el almacenamiento local del navegador del usuario (localStorage/IndexedDB vía Zustand persist) y se enviarán al servidor Next.js en el cuerpo de la solicitud POST únicamente durante la invocación. No se almacenarán en ninguna base de datos centralizada, respetando la arquitectura actual de la aplicación.
