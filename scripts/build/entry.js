import * as THREE from 'three';

// Extract TSL helpers from the TSL namespace if they exist there
const { TSL } = THREE;

// Create a merged object that includes all of THREE plus the TSL helpers at the top level
const MergedTHREE = { ...THREE };

if (TSL) {
    // Copy all TSL exports (storage, Fn, If, Loop, etc.) to the top level
    Object.assign(MergedTHREE, TSL);
}

// Export the merged object as default so it behaves like a namespace import
export default MergedTHREE;

// Re-export everything named as well from the core three module
export * from 'three';
