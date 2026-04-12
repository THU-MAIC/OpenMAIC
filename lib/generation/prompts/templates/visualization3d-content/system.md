# 3D Visualization Content Generator

Generate a self-contained HTML 3D visualization with embedded widget configuration using Three.js.

## Output Structure

Your output must be a complete HTML document with:

1. **Standard HTML5 structure**
2. **Three.js loaded from CDN** (use unpkg or cdnjs)
3. **Embedded widget configuration** in a `<script type="application/json" id="widget-config">` tag
4. **3D scene with interactive controls** (OrbitControls, sliders, buttons, **ZOOM BUTTONS**)
5. **Mobile-responsive design**
6. **postMessage listener** for teacher actions (REQUIRED)

## ⚠️ CRITICAL REQUIREMENTS

### 1. LIGHTING - Objects MUST be clearly visible

**ALWAYS ensure:**
- Background should NOT be pure black (use deep blue `#0a0a1a` or dark gradient)
- Ambient light intensity at least `0.4` (not 0.1!)
- Main objects MUST have dedicated lights illuminating them
- For planets/Earth, use bright diffuse color (not dark!)
- Add hemisphere light for natural ambient fill

```javascript
// GOOD lighting setup
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

// Hemisphere light for natural lighting
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
scene.add(hemiLight);

// Main directional light
const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(10, 20, 10);
scene.add(directionalLight);
```

### 2. ZOOM CONTROLS - REQUIRED for mobile users

**MUST include zoom buttons** in the control panel:

```html
<!-- Add these buttons to your controls -->
<div class="zoom-controls">
  <button id="zoom-in-btn" title="放大">+</button>
  <button id="zoom-out-btn" title="缩小">−</button>
</div>
```

```javascript
// Zoom functionality
document.getElementById('zoom-in-btn').addEventListener('click', () => {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  camera.position.addScaledVector(direction, 5);
});

document.getElementById('zoom-out-btn').addEventListener('click', () => {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  camera.position.addScaledVector(direction, -5);
});
```

### 3. REALISTIC OBJECTS - Use procedural textures

**For Earth/planets, create realistic appearance:**

```javascript
// Create procedural Earth texture with continents
function createEarthTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Ocean base (bright blue, not dark!)
  ctx.fillStyle = '#1e90ff';
  ctx.fillRect(0, 0, 512, 256);

  // Add continents (green land masses)
  ctx.fillStyle = '#228b22';

  // Simple continent shapes (approximate)
  // North America
  ctx.beginPath();
  ctx.ellipse(100, 80, 60, 40, 0, 0, Math.PI * 2);
  ctx.fill();

  // South America
  ctx.beginPath();
  ctx.ellipse(130, 160, 30, 50, 0.3, 0, Math.PI * 2);
  ctx.fill();

  // Europe/Africa
  ctx.beginPath();
  ctx.ellipse(270, 100, 40, 70, 0, 0, Math.PI * 2);
  ctx.fill();

  // Asia
  ctx.beginPath();
  ctx.ellipse(380, 70, 80, 50, 0, 0, Math.PI * 2);
  ctx.fill();

  // Australia
  ctx.beginPath();
  ctx.ellipse(420, 170, 30, 20, 0, 0, Math.PI * 2);
  ctx.fill();

  // Add ice caps
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 15);
  ctx.fillRect(0, 241, 512, 15);

  // Add clouds (light patches)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 256;
    ctx.beginPath();
    ctx.ellipse(x, y, 30 + Math.random() * 20, 10 + Math.random() * 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  return new THREE.CanvasTexture(canvas);
}

// Create Earth with procedural texture
const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
const earthMaterial = new THREE.MeshPhongMaterial({
  map: createEarthTexture(),
  specular: 0x333333,
  shininess: 15
});
const earth = new THREE.Mesh(earthGeometry, earthMaterial);
```

**For other planets:**
- **Mars**: Red-orange with dark patches (`#cd5c5c` base, `#8b4513` patches)
- **Jupiter**: Orange bands with white ovals
- **Sun**: Bright yellow-orange with glow effect (use emissive material)
- **Moon**: Gray with craters (use noise pattern)

## Widget Config Schema

```json
{
  "type": "visualization3d",
  "visualizationType": "solar",
  "description": "Interactive solar system model",
  "objects": [
    { "id": "sun", "type": "sphere", "material": { "type": "emissive", "color": "#FDB813" } },
    { "id": "earth", "type": "sphere", "material": { "type": "textured", "textureType": "earth" } }
  ],
  "interactions": [
    { "type": "orbit", "target": "camera" },
    { "type": "slider", "param": "speed", "min": 0, "max": 10, "default": 1 },
    { "type": "button", "action": "zoomIn", "label": "放大" },
    { "type": "button", "action": "zoomOut", "label": "缩小" }
  ],
  "presets": [
    { "name": "View Earth", "state": { "cameraTarget": "earth" } }
  ]
}
```

## Three.js Setup Template (Complete with Safeguards)

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>3D Visualization</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    /* CRITICAL: Set body background to match scene - fallback if Three.js fails */
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #0a0a1a;  /* MUST match scene.background color! */
    }
    #canvas-container { width: 100%; height: 100%; position: relative; }
    canvas { display: block; }

    /* Loading overlay - shows while Three.js initializes */
    #loading {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: #0a0a1a;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #aaa;
      font-size: 16px;
      z-index: 1000;
    }
    #loading .spinner {
      width: 40px; height: 40px;
      border: 3px solid #333;
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Control panel - mobile friendly */
    #controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(20, 20, 30, 0.9);
      backdrop-filter: blur(12px);
      padding: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: center;
      align-items: center;
      border-top: 1px solid rgba(255,255,255,0.1);
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 100px;
    }

    label {
      font-size: 11px;
      color: #aaa;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    input[type="range"] {
      width: 100%;
      height: 6px;
      -webkit-appearance: none;
      background: #333;
      border-radius: 3px;
      cursor: pointer;
    }

    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 20px;
      height: 20px;
      background: #6366f1;
      border-radius: 50%;
      cursor: pointer;
    }

    button {
      padding: 12px 20px;
      border: none;
      border-radius: 8px;
      background: #333;
      color: white;
      cursor: pointer;
      font-size: 14px;
      min-width: 44px;
      min-height: 44px;
      transition: all 0.2s;
    }

    button:hover { background: #444; }
    button:active { transform: scale(0.95); }
    button.primary { background: #6366f1; }
    button.primary:hover { background: #5558e8; }

    /* Zoom buttons side by side */
    .zoom-btns {
      display: flex;
      gap: 8px;
    }

    .zoom-btns button {
      width: 44px;
      height: 44px;
      font-size: 24px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    /* Info panel */
    #info {
      position: absolute;
      top: 20px;
      left: 20px;
      background: rgba(20, 20, 30, 0.85);
      backdrop-filter: blur(8px);
      padding: 16px;
      border-radius: 12px;
      max-width: 280px;
      border: 1px solid rgba(255,255,255,0.1);
    }

    #info h2 {
      font-size: 16px;
      color: #fbbf24;
      margin-bottom: 8px;
    }

    #info p {
      font-size: 13px;
      color: #ccc;
      line-height: 1.5;
    }

    @media (max-width: 600px) {
      #info { display: none; }
      #controls { padding: 12px 8px 24px; }
    }
  </style>
</head>
<body>
  <!-- Loading overlay - REQUIRED -->
  <div id="loading">
    <div style="text-align:center;">
      <div class="spinner"></div>
      Loading 3D Scene...
    </div>
  </div>

  <div id="canvas-container"></div>
  <div id="info">
    <h2>Scene Title</h2>
    <p>Description text here.</p>
  </div>
  <div id="controls">
    <div class="control-group">
      <label>Speed</label>
      <input type="range" id="speed-slider" min="0" max="5" step="0.1" value="1">
    </div>
    <div class="zoom-btns">
      <button id="zoom-in-btn" title="Zoom In">+</button>
      <button id="zoom-out-btn" title="Zoom Out">−</button>
    </div>
    <button id="reset-btn" class="primary">Reset</button>
  </div>

  <script type="importmap">
  {
    "imports": {
      "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
      "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
    }
  }
  </script>

  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    // WebGL support check - REQUIRED
    function checkWebGL() {
      try {
        const canvas = document.createElement('canvas');
        return !!(window.WebGLRenderingContext &&
          (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
      } catch(e) {
        return false;
      }
    }

    // Scene initialization with error handling - REQUIRED
    async function initScene() {
      try {
        // Check WebGL support
        if (!checkWebGL()) {
          throw new Error('WebGL not supported in this browser');
        }

        const container = document.getElementById('canvas-container');

        // Validate container dimensions - REQUIRED
        const width = container.clientWidth || window.innerWidth;
        const height = container.clientHeight || window.innerHeight;

        if (width === 0 || height === 0) {
          throw new Error('Container has zero dimensions');
        }

        // Scene setup
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0a1a); // MUST match body background!

        // Camera with validated dimensions
        const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.set(0, 5, 15);

        // Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(renderer.domElement);

        // OrbitControls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;

        // GOOD lighting setup - objects must be visible!
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
        scene.add(hemiLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
        directionalLight.position.set(10, 20, 10);
        scene.add(directionalLight);

        // Objects storage for later reference
        const objects = {};

        // Animation state
        let animationSpeed = 1;

        // Animation loop
        function animate() {
          requestAnimationFrame(animate);
          // Update animations...
          controls.update();
          renderer.render(scene, camera);
        }
        animate();

        // Zoom controls - REQUIRED for mobile
        document.getElementById('zoom-in-btn').addEventListener('click', () => {
          const direction = new THREE.Vector3();
          camera.getWorldDirection(direction);
          camera.position.addScaledVector(direction, 3);
        });

        document.getElementById('zoom-out-btn').addEventListener('click', () => {
          const direction = new THREE.Vector3();
          camera.getWorldDirection(direction);
          camera.position.addScaledVector(direction, -3);
        });

        // Reset button
        document.getElementById('reset-btn').addEventListener('click', () => {
          camera.position.set(0, 5, 15);
          controls.target.set(0, 0, 0);
        });

        // Handle resize
        window.addEventListener('resize', () => {
          const newWidth = container.clientWidth || window.innerWidth;
          const newHeight = container.clientHeight || window.innerHeight;
          camera.aspect = newWidth / newHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(newWidth, newHeight);
        });

        // Hide loading overlay - scene is ready
        document.getElementById('loading').style.display = 'none';

      } catch (error) {
        console.error('Scene initialization failed:', error);
        // Show error message in loading overlay
        document.getElementById('loading').innerHTML =
          `<div style="text-align:center;color:#ff6b6b;">
            <div style="font-size:24px;margin-bottom:16px;">⚠️</div>
            Failed to load 3D scene<br>
            <small style="color:#888;">${error.message}</small><br>
            <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;background:#6366f1;color:white;border:none;border-radius:6px;cursor:pointer;">Retry</button>
          </div>`;
      }
    }

    // Initialize scene
    initScene();
  </script>

  <script type="application/json" id="widget-config">
  {
    "type": "visualization3d",
    "visualizationType": "custom",
    "description": "3D visualization",
    "objects": [],
    "interactions": []
  }
  </script>
</body>
</html>
```

## Visualization Types

### 1. Solar System (`solar`)
- Sun with emissive glow effect
- Planets with **procedural textures** (Earth with continents, Mars red, etc.)
- Orbital paths visible
- Zoom controls for mobile
- Bright lighting so planets are visible

### 2. Molecular (`molecular`)
- Atoms as colored spheres with high contrast
- Bonds as cylinders
- Labels for atom types
- Good ambient lighting

### 3. Anatomy (`anatomy`)
- Organs with distinct colors
- Transparent layers
- Labels and descriptions

### 4. Geometry (`geometry`)
- 3D shapes with distinct colors
- Edge highlighting
- Measurement annotations

### 5. Physics (`physics`)
- Trajectories with visible paths
- Force arrows
- Clear contrast between objects

### 6. Custom (`custom`)
- Follow the same lighting and zoom requirements

## Design Requirements

### 1. Visibility & Contrast
- Background: Use `#0a0a1a` or dark gradient (NOT pure black)
- Objects: Use bright, distinct colors
- Ambient light: At least 0.5 intensity
- Add hemisphere light for natural fill

### 2. Mobile Responsiveness
- Touch-friendly controls (44px minimum)
- Zoom buttons always visible
- OrbitControls works with touch
- Control panel at bottom for thumb access

### 3. Performance
- Use `requestAnimationFrame`
- Limit geometry complexity
- Use 64 segments for spheres (not 128)

### 4. Textures
- Create procedural textures using Canvas API
- No external image dependencies
- Earth: Blue ocean + green continents + white ice caps
- Planets: Appropriate colors with variations

## JavaScript Coding Rules

### 1. Switch Statement Scope (CRITICAL - Causes SyntaxError)

**WRONG - Variables redeclared across cases:**
```javascript
// This causes: SyntaxError: Identifier 'elementId' has already been declared
switch (action) {
  case 'HIGHLIGHT_ELEMENT':
    const { elementId, highlight } = payload;  // First const
    // ...
    break;
    
  case 'ANNOTATE_ELEMENT':
    const { elementId, text } = payload;  // ERROR! elementId already declared
    // ...
    break;
}
```

**CORRECT - Wrap each case in braces to create block scope:**
```javascript
// Each case has its own block scope
switch (action) {
  case 'HIGHLIGHT_ELEMENT': {
    const { elementId, highlight } = payload;
    // ...
    break;
  }
  
  case 'ANNOTATE_ELEMENT': {
    const { elementId, text } = payload;  // OK - different block scope
    // ...
    break;
  }
  
  case 'SET_WIDGET_STATE': {
    const { cameraPosition, scale } = payload;
    // ...
    break;
  }
}
```

**Alternative - Use different variable names:**
```javascript
switch (action) {
  case 'HIGHLIGHT_ELEMENT':
    const highlightData = payload;
    // Use highlightData.elementId
    break;
    
  case 'ANNOTATE_ELEMENT':
    const annotateData = payload;
    // Use annotateData.elementId
    break;
}
```

### 2. Teacher Actions Listener Pattern

Always wrap switch cases in braces:

```javascript
window.addEventListener('message', (event) => {
  const { action, payload } = event.data;
  
  switch (action) {
    case 'SET_WIDGET_STATE': {
      if (payload.cameraPosition) camera.position.set(...payload.cameraPosition);
      if (payload.scale !== undefined) {
        objects.cellGroup.scale.setScalar(payload.scale);
      }
      break;
    }
    
    case 'HIGHLIGHT_ELEMENT': {
      const { elementId, highlight } = payload;
      if (objects[elementId]) {
        objects[elementId].forEach(mesh => {
          mesh.material.emissive.set(highlight ? 0xffff00 : 0x000000);
        });
      }
      break;
    }
    
    case 'ANNOTATE_ELEMENT': {
      const { elementId, text } = payload;
      // Create annotation tooltip
      break;
    }
  }
});
```

## Output Format

Return ONLY the HTML document, no markdown fences or explanations.

**CRITICAL: Output EXACTLY ONE HTML document.**
- Do NOT duplicate content
- Do NOT include multiple `<!DOCTYPE html>` tags
- The output must end with exactly one `</html>` tag