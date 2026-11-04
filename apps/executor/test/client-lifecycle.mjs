import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions, Response } = require('miniflare');
const { build } = require('esbuild');
const source = `
import { DurableObject } from 'cloudflare:workers';
import { HeyboxClient } from 'heybox-daily/client';
import { deadline } from './src/deadline.ts';
export class ClientProbe extends DurableObject {
  async fetch() {
    const scope = deadline(90_000);
    try {
      const client = new HeyboxClient({
        session: { heybox_id: '123', pkey: 'fixture', x_xhh_tokenid: 'fixture', device_id: 'fixture' },
        device: { model: 'fixture', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' },
      }, { fetchImpl: scope.fetch });
      return Response.json(await client.tasks());
    } finally { scope.close(); }
  }
}
export default { fetch(request, env) {
  return env.PROBES.get(env.PROBES.idFromName('client')).fetch(request);
} };
`;
const compiled = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:workers'] });
let completed;
const completion = new Promise(resolve => { completed = resolve; });
let upstreamRequests = 0;
const options = convertV4MiniflareOptions({ name: 'client-lifecycle', modules: true, script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-10-27', compatibilityFlags: ['nodejs_compat'], cf: false,
  durableObjects: { PROBES: { className: 'ClientProbe', useSQLite: true } }, tails: ['collector'],
  outboundService: async request => {
    upstreamRequests++;
    assert.equal(new URL(request.url).hostname, 'api.xiaoheihe.cn');
    assert.equal(new URL(request.url).pathname, '/task/list_v2/');
    return Response.json({ status: 'ok', result: { ok: true } });
  },
});
options.workers.push(...convertV4MiniflareOptions({ name: 'collector', modules: true, compatibilityDate: '2026-10-27', cf: false,
  script: `export default { async tail(events, env) {
    await env.SINK.fetch('https://sink', { method: 'POST', body: JSON.stringify(events) });
  } };`,
  serviceBindings: { SINK: async request => {
    for (const event of await request.json()) if (event.entrypoint === 'ClientProbe') completed(event);
    return new Response(null, { status: 204 });
  } },
}).workers);
const runtime = new Miniflare(options);
let timer;
try {
  await runtime.ready;
  assert.deepEqual(await (await runtime.dispatchFetch('https://probe/')).json(), { ok: true });
  // workerd delivers the DO tail only after its pending work is finished. A native
  // AbortSignal.timeout(20000) keeps this event alive long after the response.
  const event = await Promise.race([completion,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
  assert.ok(event, 'a completed client request must not keep its Durable Object alive until the 20-second timeout');
  assert.equal(event.outcome, 'ok');
  assert.equal(upstreamRequests, 1);
  console.log(JSON.stringify({ runtime: 'workerd', verified: 'client request releases DO lifecycle after response', realUpstreamRequests: 0 }));
} finally { clearTimeout(timer); await runtime.dispose(); }
