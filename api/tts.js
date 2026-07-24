// Serverless proxy for OpenAI text-to-speech. Exists for exactly one
// reason: this app is otherwise a pure static site with no backend, and an
// API key used directly from browser JS would be visible to anyone who
// opens the page (view-source / network tab) and could run up charges on
// the account it belongs to. Holding the key here, as a Vercel environment
// variable the client never receives, is the only safe way to call a paid
// TTS API from a project with this architecture.
//
// Model/voice/instructions are env-overridable so they can be changed from
// the Vercel dashboard without a code change or redeploy.

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini-tts'; // most natural/expressive OpenAI TTS model; supports steerable `instructions`
const DEFAULT_VOICE = 'nova'; // warm, clear, natural — good fit for a calm reading-aloud assistant
const DEFAULT_INSTRUCTIONS =
  'Speak warmly and clearly, at a slow, calm, deliberate pace, like a patient assistant reading aloud to someone who is visually impaired. Use natural conversational intonation — never flat or robotic.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'Cloud voice is not configured.' });
    return;
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Missing text.' });
    return;
  }

  const model = process.env.OPENAI_TTS_MODEL || DEFAULT_MODEL;
  const voice = process.env.OPENAI_TTS_VOICE || DEFAULT_VOICE;
  const instructions = process.env.OPENAI_TTS_INSTRUCTIONS || DEFAULT_INSTRUCTIONS;

  try {
    const upstream = await fetch(`${OPENAI_API_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        instructions,
        response_format: 'mp3',
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.status(502).json({ error: 'Upstream TTS request failed.', detail: detail.slice(0, 500) });
      return;
    }

    const audioBuffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(audioBuffer);
  } catch (err) {
    res.status(502).json({ error: 'Cloud voice request failed.', detail: String(err).slice(0, 500) });
  }
}
