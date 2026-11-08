import { build as bundle } from 'esbuild';
import { build } from 'vite';

export async function buildMain() {
  await bundle({
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
  });
  await bundle({
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/main/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
}

if (process.argv[1]?.endsWith('build.mjs')) {
  await buildMain();
  await build();
}
