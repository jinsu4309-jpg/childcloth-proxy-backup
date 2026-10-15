// Render.com 백업 프록시 (Node.js + Express + WebSocket)
// 기존 Cloudflare [[path]].ts 와 동일 로직:
//   /api/supabase/{projectId}/... → https://{projectId}.supabase.co/...

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const app = express();
const PORT = process.env.PORT || 10000;

const PROXY_PREFIX = '/api/supabase';
const PROJECT_ID_REGEX = /^[a-z0-9]{20}$/;

// 헬스체크 (Render 보존용)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// HTTP 프록시
app.use(PROXY_PREFIX, (req, res, next) => {
  const segments = req.path.split('/').filter(Boolean);
  const firstSegment = segments[0] || '';

  if (!PROJECT_ID_REGEX.test(firstSegment)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  const remainingPath = '/' + segments.slice(1).join('/');
  const supabaseHost = `${firstSegment}.supabase.co`;
  const query = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';

  const proxy = createProxyMiddleware({
    target: `https://${supabaseHost}`,
    changeOrigin: true,
    pathRewrite: () => remainingPath + query,
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader('Host', supabaseHost);
    },
    logLevel: 'silent',
  });

  proxy(req, res, next);
});

// 서버 + WebSocket 프록시
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith(PROXY_PREFIX)) {
    socket.destroy();
    return;
  }

  const segments = url.pathname.slice(PROXY_PREFIX.length).split('/').filter(Boolean);
  const projectId = segments[0] || '';

  if (!PROJECT_ID_REGEX.test(projectId)) {
    socket.destroy();
    return;
  }

  const supabaseHost = `${projectId}.supabase.co`;
  const upstreamPath = '/' + segments.slice(1).join('/') + url.search;

  wss.handleUpgrade(req, socket, head, (ws) => {
    const upstreamUrl = `wss://${supabaseHost}${upstreamPath}`;
    const upstreamWs = new WebSocket(upstreamUrl, {
      headers: {
        apikey: req.headers['apikey'] || '',
        authorization: req.headers['authorization'] || '',
      },
    });

    upstreamWs.on('open', () => {
      console.log(`[WS] ✅ 업스트림 연결: ${upstreamUrl}`);
    });

    ws.on('message', (data) => {
      if (upstreamWs.readyState === 1) upstreamWs.send(data);
    });
    upstreamWs.on('message', (data) => {
      if (ws.readyState === 1) ws.send(data);
    });

    ws.on('close', () => { try { upstreamWs.close(); } catch {} });
    upstreamWs.on('close', () => { try { ws.close(); } catch {} });

    ws.on('error', (e) => console.warn('[WS] client error:', e.message));
    upstreamWs.on('error', (e) => console.warn('[WS] upstream error:', e.message));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backup proxy listening on port ${PORT}`);
});
