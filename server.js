import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import ttsHandler from './api/tts.js';
import ocrHandler from './api/ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.post('/api/tts', ttsHandler);
app.post('/api/ocr', ocrHandler);

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
