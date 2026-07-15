/**
 * @fileoverview Scene debugging utilities
 * Visual helpers for diagnosing camera and rendering issues
 * @module utils/scene-debug
 */

import { createLogger } from '../core/log.js';

const log = createLogger('SceneDebug');

/**
 * Scene debugging helper
 * Access via MapShine.sceneDebug
 */
export class SceneDebug {
  constructor() {
    this.helpers = [];
    this.testObjects = [];
  }

  /**
   * Add all debug helpers to the scene
   */
  addAllHelpers() {
    this.addAxisHelper();
    this.addGridHelper();
    this.addCameraHelper();
    this.addTestCube();
    this.addTestPlane();
    
    log.info('All debug helpers added');
  }

  /**
   * Add axis helper (RGB = XYZ)
   */
  addAxisHelper() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    if (!scene) {
      log.error('Scene not available');
      return;
    }

    const THREE = window.THREE;
    const axisHelper = new THREE.AxesHelper(1000); // Note: AxesHelper (with 's')
    axisHelper.name = 'DebugAxisHelper';
    scene.add(axisHelper);
    this.helpers.push(axisHelper);

    log.info('Axis helper added (Red=X, Green=Y, Blue=Z)');
  }

  /**
   * Add grid helper at z=0
   */
  addGridHelper() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    if (!scene) return;

    const THREE = window.THREE;
    const size = 3450; // World size
    const divisions = 34; // 100px per division
    
    const gridHelper = new THREE.GridHelper(size, divisions, 0x444444, 0x888888);
    gridHelper.name = 'DebugGridHelper';
    gridHelper.position.set(size/2, size/2, 0);
    gridHelper.rotation.x = Math.PI / 2; // Rotate to XY plane
    scene.add(gridHelper);
    this.helpers.push(gridHelper);

    log.info('Grid helper added at z=0');
  }

  /**
   * Add camera frustum visualizer
   */
  addCameraHelper() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    const camera = window.canvas?.mapShine?.sceneComposer?.camera;
    if (!scene || !camera) return;

    const THREE = window.THREE;
    const cameraHelper = new THREE.CameraHelper(camera);
    cameraHelper.name = 'DebugCameraHelper';
    scene.add(cameraHelper);
    this.helpers.push(cameraHelper);

    log.info('Camera frustum helper added');
  }

  /**
   * Add bright test cube at world center
   */
  addTestCube() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    if (!scene) return;

    const THREE = window.THREE;
    const geometry = new THREE.BoxGeometry(200, 200, 200);
    const material = new THREE.MeshBasicMaterial({ 
      color: 0xff0000, 
      wireframe: true 
    });
    
    const cube = new THREE.Mesh(geometry, material);
    cube.name = 'DebugTestCube';
    cube.position.set(1725, 1725, 100); // Above base plane
    scene.add(cube);
    this.testObjects.push(cube);

    log.info('Test cube added at (1725, 1725, 100) - RED WIREFRAME');
  }

  /**
   * Add bright test plane at z=10 (token level)
   */
  addTestPlane() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    if (!scene) return;

    const THREE = window.THREE;
    const geometry = new THREE.PlaneGeometry(300, 300);
    const material = new THREE.MeshBasicMaterial({ 
      color: 0x00ff00, 
      side: THREE.DoubleSide 
    });
    
    const plane = new THREE.Mesh(geometry, material);
    plane.name = 'DebugTestPlane';
    plane.position.set(1725, 1725, 10); // Token z-level
    scene.add(plane);
    this.testObjects.push(plane);

    log.info('Test plane added at (1725, 1725, 10) - GREEN SQUARE');
  }

  /**
   * Remove all debug helpers
   */
  removeAllHelpers() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    if (!scene) return;

    [...this.helpers, ...this.testObjects].forEach(obj => {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });

    this.helpers = [];
    this.testObjects = [];
    log.info('All debug helpers removed');
  }

  /**
   * Print detailed scene graph
   */
  printSceneGraph() {
    const scene = window.canvas?.mapShine?.sceneComposer?.scene;
    if (!scene) {
      console.error('Scene not available');
      return;
    }

    console.group('🌳 Scene Graph');
    
    const traverse = (obj, depth = 0) => {
      const indent = '  '.repeat(depth);
      const pos = `(${obj.position.x.toFixed(0)}, ${obj.position.y.toFixed(0)}, ${obj.position.z.toFixed(0)})`;
      const visible = obj.visible ? '👁️' : '🚫';
      console.log(`${indent}${visible} ${obj.type} "${obj.name}" ${pos}`);
      
      obj.children.forEach(child => traverse(child, depth + 1));
    };

    traverse(scene);
    console.groupEnd();
  }

  /**
   * Print camera detailed info
   */
  printCameraInfo() {
    const camera = window.canvas?.mapShine?.sceneComposer?.camera;
    if (!camera) {
      console.error('Camera not available');
      return;
    }

    console.group('📹 Camera Details');
    console.log('Type:', camera.type);
    console.log('Position:', camera.position);
    console.log('Rotation:', {
      x: camera.rotation.x,
      y: camera.rotation.y,
      z: camera.rotation.z,
      order: camera.rotation.order
    });
    console.log('Quaternion:', camera.quaternion);
    console.log('Up vector:', camera.up);
    
    if (camera.isPerspectiveCamera) {
      console.log('FOV:', camera.fov);
      console.log('Aspect:', camera.aspect);
      console.log('Near:', camera.near);
      console.log('Far:', camera.far);
    }
    
    // Get view direction
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    console.log('Looking direction:', direction);
    
    console.groupEnd();
  }

  /**
   * Test render with known-good settings
   */
  testRender() {
    const renderer = window.canvas?.mapShine?.renderer;
    const sceneComposer = window.canvas?.mapShine?.sceneComposer;
    
    if (!renderer || !sceneComposer) {
      console.error('Renderer or scene composer not available');
      return;
    }

    console.log('🎬 Forcing test render...');
    
    // Create simple test scene
    const THREE = window.THREE;
    const testScene = new THREE.Scene();
    testScene.background = new THREE.Color(0x00ff00); // Bright green
    
    // Simple camera
    const testCamera = new THREE.PerspectiveCamera(75, 1.5, 0.1, 50000);
    testCamera.position.set(0, 0, 1000);
    testCamera.lookAt(0, 0, 0);
    
    // Red square
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide })
    );
    testScene.add(quad);
    
    // Render
    renderer.render(testScene, testCamera);
    
    console.log('✅ Test render complete');
    console.log('Expected: Green background with red square');
    console.log('If you see it, renderer works. If not, canvas/WebGL issue.');
  }

  /**
   * Diagnose canvas and renderer setup
   */
  diagnoseCanvas() {
    console.group('🖼️ Canvas Diagnostics');
    
    const threeCanvas = document.getElementById('map-shine-canvas');
    const pixiCanvas = document.getElementById('board');
    const renderer = window.canvas?.mapShine?.renderer;
    
    console.log('\n📐 THREE.js Canvas:');
    if (threeCanvas) {
      const rect = threeCanvas.getBoundingClientRect();
      console.log('  Element:', threeCanvas);
      console.log('  Size (pixels):', threeCanvas.width, 'x', threeCanvas.height);
      console.log('  CSS Size:', threeCanvas.clientWidth, 'x', threeCanvas.clientHeight);
      console.log('  BoundingRect:', rect.width, 'x', rect.height);
      console.log('  Position:', rect.left, rect.top);
      console.log('  Visibility:', window.getComputedStyle(threeCanvas).visibility);
      console.log('  Opacity:', window.getComputedStyle(threeCanvas).opacity);
      console.log('  Display:', window.getComputedStyle(threeCanvas).display);
      console.log('  Z-Index:', window.getComputedStyle(threeCanvas).zIndex);
      console.log('  Pointer-Events:', window.getComputedStyle(threeCanvas).pointerEvents);
    } else {
      console.error('  ❌ THREE.js canvas NOT FOUND');
    }
    
    console.log('\n🎨 PIXI Canvas:');
    if (pixiCanvas) {
      const rect = pixiCanvas.getBoundingClientRect();
      console.log('  Element:', pixiCanvas);
      console.log('  Size (pixels):', pixiCanvas.width, 'x', pixiCanvas.height);
      console.log('  CSS Size:', pixiCanvas.clientWidth, 'x', pixiCanvas.clientHeight);
      console.log('  Position:', rect.left, rect.top);
      console.log('  Opacity:', window.getComputedStyle(pixiCanvas).opacity);
      console.log('  Z-Index:', window.getComputedStyle(pixiCanvas).zIndex);
      console.log('  Pointer-Events:', window.getComputedStyle(pixiCanvas).pointerEvents);
    } else {
      console.error('  ❌ PIXI canvas NOT FOUND');
    }
    
    console.log('\n🎬 Renderer:');
    if (renderer) {
      console.log('  Type:', renderer.constructor.name);
      console.log('  Pixel Ratio:', renderer.getPixelRatio());
      console.log('  Size:', renderer.getSize(new THREE.Vector2()));
      console.log('  Viewport:', renderer.getViewport(new THREE.Vector4()));
      console.log('  AutoClear:', renderer.autoClear);
      console.log('  ClearColor:', renderer.getClearColor(new THREE.Color()));
      console.log('  ClearAlpha:', renderer.getClearAlpha());
    } else {
      console.error('  ❌ Renderer NOT FOUND');
    }
    
    console.log('\n💡 Issues Detected:');
    const issues = [];
    
    if (!threeCanvas) {
      issues.push('❌ THREE.js canvas not found in DOM');
    } else {
      if (threeCanvas.width === 0 || threeCanvas.height === 0) {
        issues.push('❌ Canvas has zero size');
      }
      if (window.getComputedStyle(threeCanvas).visibility === 'hidden') {
        issues.push('❌ Canvas visibility is hidden');
      }
      if (window.getComputedStyle(threeCanvas).opacity === '0') {
        issues.push('❌ Canvas opacity is 0');
      }
      if (window.getComputedStyle(threeCanvas).display === 'none') {
        issues.push('❌ Canvas display is none');
      }
      const zIndex = parseInt(window.getComputedStyle(threeCanvas).zIndex);
      const pixiZIndex = pixiCanvas ? parseInt(window.getComputedStyle(pixiCanvas).zIndex) : -1;
      if (!isNaN(zIndex) && !isNaN(pixiZIndex) && zIndex < pixiZIndex) {
        issues.push(`⚠️ THREE.js canvas z-index (${zIndex}) is below PIXI (${pixiZIndex})`);
      }
    }
    
    if (renderer) {
      const size = renderer.getSize(new THREE.Vector2());
      if (size.x === 0 || size.y === 0) {
        issues.push('❌ Renderer has zero size');
      }
    }
    
    if (issues.length === 0) {
      console.log('  ✅ No obvious issues detected');
    } else {
      issues.forEach(issue => console.log('  ' + issue));
    }
    
    console.groupEnd();
  }

  /**
   * Show help
   */
  help() {
    console.log(`
╔═══════════════════════════════════════════╗
║   Map Shine - Scene Debug Helpers         ║
╚═══════════════════════════════════════════╝

Access via: MapShine.sceneDebug

Commands:
  .diagnoseCanvas()     - Check canvas/renderer setup (START HERE!)
  .testRender()         - Force a test render (green bg + red square)
  .printCameraInfo()    - Print detailed camera state
  .addAllHelpers()      - Add all visual debug helpers
  .removeAllHelpers()   - Remove all helpers
  .printSceneGraph()    - Print full scene hierarchy
  .help()               - Show this help

Individual helpers:
  .addAxisHelper()      - RGB axis at origin
  .addGridHelper()      - Grid at z=0
  .addCameraHelper()    - Camera frustum visualization
  .addTestCube()        - Red wireframe cube at world center
  .addTestPlane()       - Green square at token level

Debugging workflow:
  1. MapShine.sceneDebug.diagnoseCanvas()    // Check canvas/renderer
  2. MapShine.sceneDebug.testRender()        // Is rendering working?
  3. MapShine.sceneDebug.printCameraInfo()   // Is camera correct?
  4. MapShine.sceneDebug.addAllHelpers()     // Visual debug
  5. MapShine.sceneDebug.printSceneGraph()   // What's in scene?
    `);
  }
}

// Create singleton instance
export const sceneDebug = new SceneDebug();
