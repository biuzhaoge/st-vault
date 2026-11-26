import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createRouteDrain } from './support/route-drain.mjs';

const server = createServer((_request, response) => response.end('upstream'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const gates = [Promise.withResolvers(), Promise.withResolvers()];
const received = [Promise.withResolvers(), Promise.withResolvers()];
const firstWritten = Promise.withResolvers();
const routes = createRouteDrain();
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  });
  const page = await browser.newPage();
  await routes.route(page, '**/batch/*', async (route) => {
    const part = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    if (part === 2) return route.fulfill({ body: 'unexpected callback' });
    const response = await route.fetch();
    received[part].resolve();
    await gates[part].promise;
    await route.fulfill({ response, body: 'transformed-' + part });
    if (part === 0) firstWritten.resolve();
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  const reads = page.evaluate(() =>
    Promise.all([0, 1].map((part) => fetch('/batch/' + part).then((r) => r.text()))),
  );
  await Promise.all(received.map((gate) => gate.promise));
  const drained = routes.drain();
  gates[0].resolve();
  await firstWritten.promise;
  // A new request proves the router is still installed while the second one is held.
  const late = await page.evaluate(() =>
    fetch('/batch/2').then(
      () => 'forwarded',
      (error) => error.name,
    ),
  );
  assert.equal(late, 'TypeError');
  gates[1].resolve();
  await drained;
  assert.deepEqual(await reads, ['transformed-0', 'transformed-1']);
  console.log('[qa] Both gated responses delivered during teardown; late request stayed closed.');
} finally {
  for (const gate of gates) gate.resolve();
  try {
    await routes.drain();
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
