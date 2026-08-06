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
                text: 'Look at this image carefully. If it contains printed or handwritten text, extract ALL of it exactly as written, preserving all punctuation, numbers, and formatting. If it is a photograph, diagram, or image with little or no text, describe in detail what you see — including people, objects, colours, setting, and any notable details. Respond with only the extracted text or description, no preamble or labels.',
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
    const text = json.choices?.[0]?.message?.content?.trim() || '';
    res.status(200).json({ text, confidence: 95 });
  } catch (err) {
    res.status(502).json({ error: 'OCR request failed.', detail: String(err).slice(0, 500) });
  }
}
