// qrserver.js
// Serves a tiny status page over HTTP so you can view the login QR code and
// connection status from a browser — essential on Railway, where there's no
// local terminal to look at. Uses only Node's built-in http module, no
// extra framework needed.

const http = require('http');

let latestQrDataUrl = null; // set via setQr() when a new QR is generated
let status = 'starting'; // 'starting' | 'waiting_for_scan' | 'ready' | 'disconnected'

function setQr(dataUrl) {
  latestQrDataUrl = dataUrl;
  status = 'waiting_for_scan';
}

function setStatus(newStatus) {
  status = newStatus;
  if (newStatus === 'ready') latestQrDataUrl = null; // no need to show QR once logged in
}

function renderPage() {
  if (status === 'ready') {
    return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>✅ Bot is connected and running</h2>
      <p>No action needed here.</p>
    </body></html>`;
  }

  if (status === 'waiting_for_scan' && latestQrDataUrl) {
    return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>Scan this QR code with the bot's WhatsApp number</h2>
      <p>WhatsApp → Settings → Linked Devices → Link a Device</p>
      <img src="${latestQrDataUrl}" alt="QR code" style="width:300px;height:300px;" />
      <p style="color:#888;">This page auto-refreshes every 5 seconds.</p>
      <script>setTimeout(() => location.reload(), 5000);</script>
    </body></html>`;
  }

  return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
    <h2>Status: ${status}</h2>
    <p>Waiting for the bot to generate a login QR code...</p>
    <script>setTimeout(() => location.reload(), 5000);</script>
  </body></html>`;
}

function startServer() {
  const port = process.env.PORT || 3000;
  const host = '0.0.0.0'; // Explicit bind — required for Railway's proxy to reach the container.
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage());
  });

  server.on('error', (err) => {
    console.error('[qrserver] Failed to start HTTP server:', err.message);
  });

  server.listen(port, host, () => {
    console.log(`[qrserver] Status page listening on ${host}:${port}`);
  });

  return server;
}

module.exports = { startServer, setQr, setStatus };
