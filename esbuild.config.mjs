import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const options = {
  entryPoints: ['src/plugin/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: 'main.js',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
  const output = 'dist/vault-rescue-transfer';
  await mkdir(output, { recursive: true });
  for (const file of ['main.js', 'manifest.json']) {
    await copyFile(file, `${output}/${file}`);
  }
}
