// Cloudflare Worker entry: serves the API and routes WebSockets to per-room Durable Objects.
// Static files (the game client) are served by Workers Static Assets from ./dist.
export { GameRoom } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return Response.json({ ok: true });
    if (url.pathname === '/api/room' && request.method === 'POST') {
      return Response.json({ code: newCode() });
    }
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4,8})$/i);
    if (m) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const code = m[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const fwd = new URL(request.url);
      fwd.searchParams.set('code', code);
      return stub.fetch(new Request(fwd.toString(), request));
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
