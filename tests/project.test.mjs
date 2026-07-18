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

test('the interface ships its own fonts instead of calling a font CDN', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(styles, /@font-face/);
  assert.match(styles, /\.woff2/);
});

test('multi-page image export uses the global document, not the scan object', async () => {
  const exporters = await readFile(new URL('../src/exporters.js', import.meta.url), 'utf8');
  // The scan document was previously passed as a parameter named `document`,
  // shadowing the DOM global and breaking the multi-page download fallback.
  assert.doesNotMatch(exporters, /function exportImages\(document\)/);
});

test('scanner includes live camera, automatic edge detection and scan modes', async () => {
  const [main, detector, scanner] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/detector.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/scanner.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /getUserMedia/);
  assert.match(main, /detectDocument/);
  // The live viewfinder must use the lightweight detector so it stays smooth
  // on a phone; the heavy consensus pipeline is only for the captured still.
  assert.match(detector, /export async function detectDocumentLive/);
  assert.match(main, /detectDocumentLive/);
  assert.match(detector, /findContours/);
  assert.match(detector, /approxPolyDP/);
  assert.match(detector, /adaptiveThreshold/);
  assert.match(detector, /convexHull/);
  assert.match(detector, /equalizeHist/);
  assert.match(detector, /HoughLinesP/);
  assert.match(detector, /rankWithConsensus/);
  assert.match(detector, /quadGeometry/);
  assert.match(detector, /paperContrast/);
  assert.match(detector, /frameLike/);
  assert.match(detector, /detectDocumentDetailed/);
  assert.match(scanner, /getPerspectiveTransform/);
  assert.match(scanner, /warpPerspective/);
  assert.match(scanner, /normalizeIllumination/);
  assert.match(scanner, /adaptiveThreshold/);
  assert.match(scanner, /equalizeHist/);
  assert.match(scanner, /addWeighted/);
  assert.match(main, /renderFilterPreview/);
  assert.match(main, /missedFrames/);
  assert.match(main, /latestConfidence/);
  for (const mode of ['shadow', 'lighten', 'enhance', 'eco', 'gray', 'bw', 'invert']) assert.match(scanner, new RegExp(`mode === '${mode}'`));
});

test('mobile layout uses the visible viewport and prevents horizontal clipping', async () => {
  const [styles, html] = await Promise.all([
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(styles, /height:\s*100dvh/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /max-width:\s*100vw/);
  assert.match(styles, /overflow-x:\s*hidden/);
  assert.match(styles, /max-height:\s*calc\(min\(58dvh,\s*440px\)\s*-\s*28px\)/);
});
