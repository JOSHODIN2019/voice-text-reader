import express from 'express';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Mount Vercel-style serverless handlers as Express routes
async function loadHandler(name) {
  const mod = await import(`./api/${name}.js`);
  return mod.default;
}

app.post('/api/tts', async (req, res) => {
  const handler = await loadHandler('tts');
  handler(req, res);
});

app.post('/api/ocr', async (req, res) => {
  const handler = await loadHandler('ocr');
  handler(req, res);
});

// SPA fallback — serve index.html for any unmatched path
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
