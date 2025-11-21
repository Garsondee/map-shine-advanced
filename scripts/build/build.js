const esbuild = require('esbuild');
const path = require('path');

async function build() {
  console.log('Building custom Three.js bundle (WebGL-only)...');

  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, 'entry.js')],
      bundle: true,
      outfile: path.resolve(__dirname, '../vendor/three/three.custom.js'),
      format: 'esm',
      target: ['es2022'],
      minify: false, // Keep readable for debugging
      sourcemap: true,
      alias: {},
      logLevel: 'info',
    });

    console.log('Build complete: scripts/vendor/three/three.custom.js');
  } catch (e) {
    console.error('Build failed:', e);
    process.exit(1);
  }
}

build();
