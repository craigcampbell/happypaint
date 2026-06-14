import { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';
import { PAINT_TYPES, PAINT_PROPERTIES } from '../utils/paintTypes';
import { VIRTUAL_CANVAS_WIDTH, VIRTUAL_CANVAS_HEIGHT, MURAL_BACKGROUND_COLOR } from '../utils/constants';

const VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vUv = uv;
    vPosition = worldPos.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDirection = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  varying vec2 vUv;
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  uniform sampler2D uCanvasTexture;
  uniform sampler2D uHeightMap;
  uniform sampler2D uWeaveTexture;
  uniform float uTime;
  uniform vec3 uLightDirection;
  uniform vec3 uLightColor;
  uniform float uAmbientLight;
  uniform float uWeaveStrength;
  uniform bool uShowImpasto;

  void main() {
    // Sample the paint color
    vec4 paintColor = texture2D(uCanvasTexture, vUv);
    bool isCleanCanvas = paintColor.r > 0.985 && paintColor.g > 0.985 && paintColor.b > 0.985;

    // Compute height and normal from height map
    float h = 0.0;
    vec3 perturbedNormal = vNormal;
    if (uShowImpasto) {
      vec2 texelSize = 1.0 / vec2(textureSize(uHeightMap, 0));
      float hL = texture2D(uHeightMap, vUv + vec2(-texelSize.x, 0.0)).r;
      float hR = texture2D(uHeightMap, vUv + vec2(texelSize.x, 0.0)).r;
      float hD = texture2D(uHeightMap, vUv + vec2(0.0, -texelSize.y)).r;
      float hU = texture2D(uHeightMap, vUv + vec2(0.0, texelSize.y)).r;
      h = texture2D(uHeightMap, vUv).r;
      float strength = 3.0;
      vec3 dx = vec3(2.0 * texelSize.x, 0.0, (hR - hL) * strength);
      vec3 dy = vec3(0.0, 2.0 * texelSize.y, (hU - hD) * strength);
      perturbedNormal = normalize(cross(dx, dy));
      perturbedNormal = normalize(vNormal + perturbedNormal * 0.8);
    }

    // Lighting
    vec3 N = normalize(perturbedNormal);
    vec3 L = normalize(uLightDirection);
    vec3 V = normalize(vViewDirection);
    vec3 H = normalize(L + V);

    float NdotL = max(dot(N, L), 0.0);
    float NdotH = max(dot(N, H), 0.0);

    // Ambient
    vec3 ambient = uAmbientLight * uLightColor;

    // Diffuse
    vec3 diffuse = NdotL * uLightColor;

    // Specular (Blinn-Phong) - controlled by height for wet/oil look
    float specPower = 4.0 + h * 32.0;
    float spec = pow(NdotH, specPower) * (0.1 + h * 0.9);

    // Canvas weave
    float weave = texture2D(uWeaveTexture, vUv * 200.0).r;
    float weaveMod = 1.0 + (weave - 0.5) * uWeaveStrength;

    // Composite lighting
    vec3 lit = paintColor.rgb * (ambient + diffuse) * weaveMod + spec * uLightColor * paintColor.rgb;

    // Subtle shadow in the crevices
    lit *= 1.0 - (1.0 - h) * 0.15 * (1.0 - NdotL);

    gl_FragColor = isCleanCanvas ? vec4(1.0) : vec4(lit, paintColor.a);
  }
`;

export function usePaintEngine(dimensions, viewport, paintCanvasRef, isDrawing = false, impastoActive = true) {
  const containerRef = useRef(null);
  const [engine, setEngine] = useState(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const materialRef = useRef(null);
  const heightCanvasRef = useRef(null);
  const weaveCanvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const paintTextureRef = useRef(null);
  const heightTextureRef = useRef(null);
  const paintDirtyRef = useRef(false);
  const heightDirtyRef = useRef(false);
  const isDrawingRef = useRef(false);
  const lastRemoteUploadRef = useRef(0);
  isDrawingRef.current = isDrawing;

  // When impasto isn't active, the lightweight 2D blit display takes over and
  // the WebGL pass is paused — no 96MB/frame texture upload.
  const impastoActiveRef = useRef(impastoActive);
  impastoActiveRef.current = impastoActive;

  // Initialize Three.js
  const initEngine = useCallback((container) => {
    if (!container) return;
    containerRef.current = container;

    const width = dimensions.width;
    const height = dimensions.height;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera (orthographic for 2D canvas feel with 3D lighting)
    const frustumSize = Math.max(width, height) / viewport.zoom;
    const aspect = width / height;
    const camera = new THREE.OrthographicCamera(
      -frustumSize * aspect / 2,
      frustumSize * aspect / 2,
      frustumSize / 2,
      -frustumSize / 2,
      0.1,
      1000
    );
    camera.position.z = 5;
    // Position camera to look at the viewport center
    camera.position.x = viewport.x - VIRTUAL_CANVAS_WIDTH / 2;
    camera.position.y = VIRTUAL_CANVAS_HEIGHT / 2 - viewport.y;
    camera.lookAt(camera.position.x, camera.position.y, 0);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(width, height, true);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Create paint texture from the paint canvas
    const paintTex = new THREE.CanvasTexture(paintCanvasRef.current);
    paintTex.colorSpace = THREE.SRGBColorSpace;
    paintTex.minFilter = THREE.LinearFilter;
    paintTex.magFilter = THREE.LinearFilter;
    paintTextureRef.current = paintTex;

    // Create height map canvas (off-screen)
    const heightCanvas = document.createElement('canvas');
    heightCanvas.width = VIRTUAL_CANVAS_WIDTH;
    heightCanvas.height = VIRTUAL_CANVAS_HEIGHT;
    const hctx = heightCanvas.getContext('2d');
    hctx.fillStyle = '#808080'; // Neutral height (50% gray)
    hctx.fillRect(0, 0, VIRTUAL_CANVAS_WIDTH, VIRTUAL_CANVAS_HEIGHT);
    heightCanvasRef.current = heightCanvas;

    const heightTex = new THREE.CanvasTexture(heightCanvas);
    heightTex.minFilter = THREE.LinearFilter;
    heightTex.magFilter = THREE.LinearFilter;
    heightTextureRef.current = heightTex;

    // Create weave texture (procedural canvas grain)
    const weaveCanvas = document.createElement('canvas');
    weaveCanvas.width = 256;
    weaveCanvas.height = 256;
    const wctx = weaveCanvas.getContext('2d');
    generateWeaveTexture(wctx, 256, 256);
    weaveCanvasRef.current = weaveCanvas;

    const weaveTex = new THREE.CanvasTexture(weaveCanvas);
    weaveTex.wrapS = THREE.RepeatWrapping;
    weaveTex.wrapT = THREE.RepeatWrapping;
    weaveTex.minFilter = THREE.LinearMipmapLinearFilter;
    weaveTex.magFilter = THREE.LinearFilter;

    // Create plane geometry matching virtual canvas size
    const planeW = VIRTUAL_CANVAS_WIDTH;
    const planeH = VIRTUAL_CANVAS_HEIGHT;
    const geometry = new THREE.PlaneGeometry(planeW, planeH);

    // Shader material
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uCanvasTexture: { value: paintTex },
        uHeightMap: { value: heightTex },
        uWeaveTexture: { value: weaveTex },
        uTime: { value: 0 },
        uLightDirection: { value: new THREE.Vector3(5, 10, 7).normalize() },
        uLightColor: { value: new THREE.Color(1, 0.98, 0.95) },
        uAmbientLight: { value: 0.35 },
        uWeaveStrength: { value: 0.08 },
        uShowImpasto: { value: true },
      },
      transparent: true,
    });
    materialRef.current = material;

    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

    // Large white background plane behind the canvas
    const bgGeom = new THREE.PlaneGeometry(VIRTUAL_CANVAS_WIDTH * 2, VIRTUAL_CANVAS_HEIGHT * 2);
    const bgMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(MURAL_BACKGROUND_COLOR), side: THREE.DoubleSide });
    const bgPlane = new THREE.Mesh(bgGeom, bgMat);
    bgPlane.position.z = -0.01;
    scene.add(bgPlane);

    setEngine({
      scene,
      camera,
      renderer,
      material,
      heightCanvas,
      paintTexture: paintTex,
      heightTexture: heightTex,
    });

    paintDirtyRef.current = true; // ensure first frame uploads canvas content
    heightDirtyRef.current = true;

    return renderer;
  }, [dimensions, paintCanvasRef]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (rendererRef.current) {
        rendererRef.current.dispose();
        if (containerRef.current && rendererRef.current.domElement) {
          containerRef.current.removeChild(rendererRef.current.domElement);
        }
      }
    };
  }, []);

  // Animation loop
  useEffect(() => {
    if (!engine) return;

    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      // Paused while the fast 2D blit display is showing.
      if (!impastoActiveRef.current) return;
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        const now = performance.now();
        const isLocal = isDrawingRef.current;

        if (isLocal) {
          // Local drawing: always upload every frame regardless of dirty state
          if (paintTextureRef.current) {
            paintTextureRef.current.needsUpdate = true;
          }
          if (heightTextureRef.current) {
            heightTextureRef.current.needsUpdate = true;
          }
        } else if (paintDirtyRef.current || heightDirtyRef.current) {
          // Remote changes: throttle uploads to ~30fps to avoid drowning the GPU
          if (now - lastRemoteUploadRef.current >= 33) {
            if (paintTextureRef.current) {
              paintTextureRef.current.needsUpdate = true;
            }
            if (heightTextureRef.current) {
              heightTextureRef.current.needsUpdate = true;
            }
            paintDirtyRef.current = false;
            heightDirtyRef.current = false;
            lastRemoteUploadRef.current = now;
          }
        }

        if (materialRef.current) {
          materialRef.current.uniforms.uTime.value = now * 0.001;
          materialRef.current.uniforms.uShowImpasto.value = true;
        }

        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [engine]);

  // When impasto re-activates, force a fresh upload so WebGL reflects every
  // stroke painted while it was paused.
  useEffect(() => {
    if (!impastoActive) return;
    paintDirtyRef.current = true;
    heightDirtyRef.current = true;
    if (paintTextureRef.current) paintTextureRef.current.needsUpdate = true;
    if (heightTextureRef.current) heightTextureRef.current.needsUpdate = true;
  }, [impastoActive]);

  // Update camera/rendered frustum when dimensions or viewport change
  useEffect(() => {
    if (!rendererRef.current || !cameraRef.current) return;

    const width = dimensions.width;
    const height = dimensions.height;
    const aspect = width / height;
    const frustumSize = Math.max(width, height) / viewport.zoom;

    const cam = cameraRef.current;
    cam.left = -frustumSize * aspect / 2;
    cam.right = frustumSize * aspect / 2;
    cam.top = frustumSize / 2;
    cam.bottom = -frustumSize / 2;
    cam.position.x = viewport.x - VIRTUAL_CANVAS_WIDTH / 2;
    cam.position.y = VIRTUAL_CANVAS_HEIGHT / 2 - viewport.y;
    cam.lookAt(cam.position.x, cam.position.y, 0);
    cam.updateProjectionMatrix();

    rendererRef.current.setSize(width, height, true);
    paintDirtyRef.current = true;
  }, [dimensions, viewport]);

  // Apply impasto from a height map stroke
  const applyImpasto = useCallback((points, size, paintType, opacity) => {
    const hCanvas = heightCanvasRef.current;
    if (!hCanvas) return;

    const props = PAINT_PROPERTIES[paintType] || PAINT_PROPERTIES[PAINT_TYPES.NONE];
    const ctx = hCanvas.getContext('2d');
    const baseHeight = props.impasto * opacity;
    const baseStrength = (baseHeight - 0.5) * 255; // offset from neutral gray

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.8;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const t = i / Math.max(1, points.length - 1);
      const taper = 1 - Math.abs(t - 0.5) * 1.6;
      const strength = baseStrength * Math.max(0.15, taper);
      const gray = Math.round(128 + strength);

      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 0.5);
      const gVal = `rgb(${gray},${gray},${gray})`;
      gradient.addColorStop(0, gVal);
      gradient.addColorStop(0.5, gVal);
      gradient.addColorStop(1, 'rgb(128,128,128)');

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    heightDirtyRef.current = true;
  }, []);

  // Smear height map (palette knife)
  const smearHeight = useCallback((points, size, strength) => {
    const hCanvas = heightCanvasRef.current;
    if (!hCanvas) return;

    const ctx = hCanvas.getContext('2d');
    const r = Math.ceil(size * strength);

    // Compute bounding box for all smear points
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x - r);
      minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r);
      maxY = Math.max(maxY, p.y + r);
    }
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(hCanvas.width, Math.ceil(maxX));
    maxY = Math.min(hCanvas.height, Math.ceil(maxY));

    const regionW = maxX - minX;
    const regionH = maxY - minY;
    if (regionW <= 0 || regionH <= 0) return;

    const imageData = ctx.getImageData(minX, minY, regionW, regionH);

    for (const p of points) {
      smearAtPoint(imageData, p.x - minX, p.y - minY, size * strength);
    }

    ctx.putImageData(imageData, minX, minY);
    heightDirtyRef.current = true;
  }, []);

  // Erase height (scrape)
  const scrapeHeight = useCallback((points, size) => {
    const hCanvas = heightCanvasRef.current;
    if (!hCanvas) return;

    const ctx = hCanvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.5;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 0.5);
      gradient.addColorStop(0, 'rgb(120,120,120)'); // Slightly below neutral
      gradient.addColorStop(1, 'rgb(128,128,128)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    heightDirtyRef.current = true;
  }, []);

  // Clear height map
  const clearHeightMap = useCallback(() => {
    const hCanvas = heightCanvasRef.current;
    if (!hCanvas) return;
    const ctx = hCanvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, hCanvas.width, hCanvas.height);
    heightDirtyRef.current = true;
    if (heightTextureRef.current) {
      heightTextureRef.current.needsUpdate = true;
    }
  }, []);

  const markDirty = useCallback(() => {
    paintDirtyRef.current = true;
    if (paintTextureRef.current) {
      paintTextureRef.current.needsUpdate = true;
    }
  }, []);

  return {
    containerRef,
    initEngine,
    engine,
    getHeightCanvas: () => heightCanvasRef.current,
    applyImpasto,
    smearHeight,
    scrapeHeight,
    clearHeightMap,
    markDirty,
  };
}

function smearAtPoint(imageData, cx, cy, radius) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const r = Math.floor(radius);
  let sumGray = 0;
  let count = 0;

  // Sample the neighborhood
  const samples = [];
  for (let dy = -r; dy <= r; dy += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      const sx = Math.floor(cx + dx);
      const sy = Math.floor(cy + dy);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
        const idx = (sy * w + sx) * 4;
        const gray = data[idx]; // R channel is height
        sumGray += gray;
        count++;
        samples.push(gray);
      }
    }
  }

  if (count === 0) return;

  const avg = Math.round(sumGray / count);

  // Blend the center area toward the average
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      const sx = Math.floor(cx + dx);
      const sy = Math.floor(cy + dy);
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;

      const factor = 1 - (dist / r);
      const t = factor * 0.4;
      const idx = (sy * w + sx) * 4;
      data[idx] = Math.round(data[idx] * (1 - t) + avg * t);
      data[idx + 1] = data[idx];
      data[idx + 2] = data[idx];
    }
  }
}

function generateWeaveTexture(ctx, w, h) {
  // Base fill
  ctx.fillStyle = 'rgb(140,135,125)';
  ctx.fillRect(0, 0, w, h);

  // Canvas weave pattern
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const modX = x % 4;
      const modY = y % 4;
      let val = 140;

      if (modY < 1 || modY >= 3) {
        val = modX < 2 ? 130 : 150;
      } else {
        val = modX < 2 ? 148 : 132;
      }

      // Add noise
      const noise = (Math.random() - 0.5) * 6;
      val += noise;
      data[idx] = Math.round(val);
      data[idx + 1] = Math.round(val);
      data[idx + 2] = Math.round(val);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

export function updatePaintTextureFromCanvas(paintTex, canvas) {
  if (!paintTex || !canvas) return;
  paintTex.needsUpdate = true;
}
