// A fake S3 (Cloudflare R2) on localhost for the tests: checks there is a V4 signature, keeps objects in memory.
import {createServer} from 'node:http';

export async function fakeS3() {
  const objects = new Map();
  const state = {dropPuts: 0};
  const server = createServer((req, res) => {
    if (!/^AWS4-HMAC-SHA256 Credential=test\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[\w;-]+, Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) { res.writeHead(403).end('no signature'); return; }
    const key = decodeURIComponent(req.url);
    // A dropped connection, as a home network does now and then.
    if (req.method === 'PUT' && state.dropPuts > 0) { state.dropPuts--; req.socket.destroy(); return; }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); });
    } else if (req.method === 'HEAD' || req.method === 'GET') {
      const b = objects.get(key);
      if (!b) { res.writeHead(404).end(); return; }
      res.writeHead(200, {'content-length': b.length});
      res.end(req.method === 'GET' ? b : undefined);
    } else if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = {endpoint: `http://127.0.0.1:${server.address().port}`, id: 'test', secret: 'secret', bucket: 'reels'};
  return {objects, cfg, state, close: () => server.close()};
}
