// A throwaway HTTP endpoint that stands in for the studio's management
// software: it records what was POSTed and can be told what status to answer
// with, so the handoff flow is tested against a real socket, not a stub.
import http from 'node:http';

export async function startWebhookReceiver() {
  const received = [];
  let status = 200;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { /* recorded as null */ }
      received.push({ method: req.method, headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    answerWith(next) { status = next; },
    last() { return received[received.length - 1] || null; },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
