export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'OCR service not configured.' });
    return;
  }

  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'Missing image data.' });
    return;
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Look at this image carefully.\n\nIf it contains printed or handwritten text, respond with:\nTEXT: followed by all the text exactly as written, preserving all punctuation, numbers, and formatting.\n\nIf it is a photograph, drawing, diagram, or scene with little or no text, respond with:\nIMAGE: followed by a detailed description of what you see, including people, objects, colours, setting, and any notable details.\n\nRespond with only the prefix and content — no extra explanation.',
              },
              {
                type: 'image_url',
                image_url: { url: image, detail: 'high' },
              },
            ],
          },
        ],
        max_tokens: 2000,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.status(502).json({ error: 'GPT-4o Vision request failed.', detail: detail.slice(0, 500) });
      return;
    }

    const json = await upstream.json();
    const raw  = json.choices?.[0]?.message?.content?.trim() || '';
    let type = 'text';
    let text = raw;
    if (raw.startsWith('IMAGE:')) { type = 'image'; text = raw.slice(6).trim(); }
    else if (raw.startsWith('TEXT:')) { type = 'text';  text = raw.slice(5).trim(); }
    res.status(200).json({ text, confidence: 95, type });
  } catch (err) {
    res.status(502).json({ error: 'OCR request failed.', detail: String(err).slice(0, 500) });
  }
}
