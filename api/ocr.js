export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'OCR service not configured.' });
    return;
  }

  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'Missing image data.' });
    return;
  }

  const base64 = image.replace(/^data:image\/\w+;base64,/, '');

  try {
    const upstream = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64 },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            },
          ],
        }),
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.status(502).json({ error: 'Google Vision request failed.', detail: detail.slice(0, 500) });
      return;
    }

    const json = await upstream.json();
    const response = json.responses?.[0];

    if (response?.error) {
      res.status(502).json({ error: response.error.message });
      return;
    }

    const text = response?.fullTextAnnotation?.text?.trim() || '';

    // average block confidences for a single confidence score
    const blocks = response?.fullTextAnnotation?.pages?.flatMap(p => p.blocks) || [];
    const confidence = blocks.length
      ? Math.round((blocks.reduce((sum, b) => sum + (b.confidence ?? 1), 0) / blocks.length) * 100)
      : (text ? 90 : 0);

    res.status(200).json({ text, confidence });
  } catch (err) {
    res.status(502).json({ error: 'OCR request failed.', detail: String(err).slice(0, 500) });
  }
}
