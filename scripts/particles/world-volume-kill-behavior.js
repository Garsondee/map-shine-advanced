/**
 * Quarks particle behavior: kill particles outside a world-axis-aligned box.
 *
 * Quarks runs behaviors on the CPU each frame. Particles are removed when
 * `particle.age >= particle.life`; this behavior forces that condition when
 * world-space position leaves [min, max].
 *
 * @module particles/world-volume-kill-behavior
 */

export class WorldVolumeKillBehavior {
  /**
   * @param {import('three').Vector3} min
   * @param {import('three').Vector3} max
   */
  constructor(min, max) {
    this.type = 'WorldVolumeKill';
    this.enabled = true;
    this.min = min.clone();
    this.max = max.clone();
    const THREE = window.THREE;
    this._tempVec = THREE ? new THREE.Vector3() : null;
  }

  /** @param {unknown} particle @param {unknown} system */
  initialize(particle, system) { /* no-op */ }

  /**
   * @param {import('../../libs/three.quarks.module.js').Particle} particle
   * @param {number} delta
   * @param {import('../../libs/three.quarks.module.js').ParticleSystem} system
   */
  update(particle, delta, system) {
    if (this.enabled === false) return;
    const p = particle.position;
    if (!p) return;

    let wx = p.x;
    let wy = p.y;
    let wz = p.z;

    if (system?.worldSpace === true) {
      // Already world space
    } else if (system && system.emitter && system.emitter.matrixWorld) {
      const THREE = window.THREE;
      if (!this._tempVec && THREE) this._tempVec = new THREE.Vector3();
      if (this._tempVec) {
        this._tempVec.set(p.x, p.y, p.z);
        this._tempVec.applyMatrix4(system.emitter.matrixWorld);
        wx = this._tempVec.x;
        wy = this._tempVec.y;
        wz = this._tempVec.z;
      }
    }

    if (
      wx < this.min.x || wx > this.max.x ||
      wy < this.min.y || wy > this.max.y ||
      wz < this.min.z || wz > this.max.z
    ) {
      if (typeof particle.life === 'number') {
        particle.age = particle.life;
      } else {
        particle.age = 1e9;
      }
    }
  }

  /** @param {number} delta */
  frameUpdate(delta) { /* no-op */ }

  clone() {
    return new WorldVolumeKillBehavior(this.min, this.max);
  }

  reset() { /* no-op */ }
}
