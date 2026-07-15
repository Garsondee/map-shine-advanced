import { 
    ParticleSystem, 
    ConstantValue, 
    ColorRange, 
    Vector4, 
    RenderMode,
    GridEmitter,
    IntervalValue
} from '../libs/three.quarks.module.js';
import { createLogger } from '../core/log.js';

const log = createLogger('DebugParticles');

// Simple behavior for debug: accelerates particles along world -Z so fall through the volume is visible
class DebugLinearGravityBehavior {
    constructor(direction, acceleration) {
        this.type = 'DebugLinearGravity';
        this.direction = direction.clone().normalize();
        this.acceleration = acceleration;
    }

    initialize(particle, system) { /* no-op */ }

    update(particle, delta, system) {
        if (!particle.velocity) return;
        particle.velocity.addScaledVector(this.direction, this.acceleration * delta);
    }

    frameUpdate(delta) { /* no-op */ }

    clone() {
        return new DebugLinearGravityBehavior(this.direction, this.acceleration);
    }

    reset() { /* no-op */ }
}

export class DebugParticles {
    constructor(batchRenderer, scene) {
        this.batchRenderer = batchRenderer;
        this.scene = scene;
        this.system = null;
        this.texture = this._createDebugTexture();
        this.volumeHelper = null;
        
        this._initSystem();
    }

    _createDebugTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FF0000'; // Red for visibility
        ctx.fillRect(0, 0, 32, 32);
        return new window.THREE.CanvasTexture(canvas);
    }

    _initSystem() {
        const THREE = window.THREE;

        // Read scene rectangle from Foundry dimensions
        const d = window.canvas?.dimensions;
        const sceneX = d?.sceneX ?? 0;
        const sceneY = d?.sceneY ?? 0;
        const sceneW = d?.sceneWidth ?? d?.width ?? 2000;
        const sceneH = d?.sceneHeight ?? d?.height ?? 2000;

        // Debug material
        const material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            blending: THREE.AdditiveBlending,
            color: 0xffffff,
            depthWrite: false
        });

        // Create system
        // Floor at 0, Ceiling at 7500.
        // We emit from the ceiling and apply a very strong -Z acceleration so motion is obvious.
        const gravity = new DebugLinearGravityBehavior(new THREE.Vector3(0, 0, -1), 200000);
        this.system = new ParticleSystem({
            duration: 5,
            looping: true,
            startLife: new IntervalValue(4, 5), // Life enough to reach bottom? Speed * Life approx Distance
            startSpeed: new ConstantValue(5000), // Much higher initial speed to showcase motion
            startSize: new ConstantValue(50),
            startColor: new ColorRange(new Vector4(1, 0, 0, 1), new Vector4(1, 0, 0, 1)),
            worldSpace: true,
            maxParticles: 1000,
            emissionOverTime: new ConstantValue(50),
            shape: new GridEmitter({ width: sceneW, height: sceneH }),
            material: material,
            renderMode: RenderMode.BillBoard,
            startRotation: new ConstantValue(0),
            behaviors: [gravity],
        });

        // Position at Ceiling above the center of the scene rectangle
        // Make the volume tall: ceiling at z=7500 (5x original 500)
        const centerX = sceneX + sceneW / 2;
        const centerY = sceneY + sceneH / 2;
        this.system.emitter.position.set(centerX, centerY, 7500);
        // Keep emitter aligned with the scene rectangle (no tilt)
        this.system.emitter.rotation.set(0, 0, 0);

        // Attach emitter to the scene graph so Quarks considers it valid
        if (this.scene && this.system.emitter.parent !== this.scene) {
          this.scene.add(this.system.emitter);
        }

        // Debug wireframe box to visualize particle volume
        // Base: z=0 (ground plane), Top: z=7500 (emitter height)
        // Footprint: scene rectangle in world space
        if (this.scene) {
          const min = new THREE.Vector3(sceneX, sceneY, 0);
          const max = new THREE.Vector3(sceneX + sceneW, sceneY + sceneH, 7500);
          const box = new THREE.Box3(min, max);
          const helper = new THREE.Box3Helper(box, 0x00ff00);
          helper.name = 'DebugParticleVolumeBox';
          this.scene.add(helper);
          this.volumeHelper = helper;
        }

        this.batchRenderer.addSystem(this.system);
        log.info('Debug particle system created');
    }

    update(dt) {
        if (this.system) {
            // ensure it's updating if needed
        }
    }

    dispose() {
        if (this.system) {
            this.batchRenderer.deleteSystem(this.system);
            this.system = null;
        }
        if (this.texture) {
            this.texture.dispose();
        }
        if (this.volumeHelper && this.scene) {
            this.scene.remove(this.volumeHelper);
            this.volumeHelper = null;
        }
    }
}
