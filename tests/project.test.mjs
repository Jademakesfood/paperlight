import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('web app manifest describes an installable standalone app', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '.');
  assert.ok(manifest.icons.some((entry) => entry.sizes === '512x512'));
});

test('offline worker includes the app shell and a network fallback', async () => {
  const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /manifest\.webmanifest/);
  assert.match(worker, /caches\.match/);
  assert.doesNotThrow(() => new Function(worker));
});

test('privacy-sensitive features use local browser APIs', async () => {
  const [main, storage] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/storage.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /createWorker/);
  assert.match(storage, /indexedDB/);
  assert.doesNotMatch(`${main}\n${storage}`, /fetch\(['"]https?:/);
});

test('scanner includes live camera, automatic edge detection and scan modes', async () => {
  const [main, detector, scanner] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/detector.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scanner.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /getUserMedia/);
  assert.match(main, /detectDocument/);
  assert.match(detector, /findContours/);
  assert.match(detector, /approxPolyDP/);
  for (const mode of ['shadow', 'lighten', 'enhance', 'eco', 'gray', 'bw', 'invert']) assert.match(scanner, new RegExp(`mode === '${mode}'`));
});
