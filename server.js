import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const jobs = new Map();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'flowforge-backend', mode: process.env.VIDEO_PROVIDER || 'test' });
});

app.post('/api/generate', (req, res) => {
  const { prompt, duration = 10, aspectRatio = '9:16' } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'A valid prompt is required.' });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    prompt: prompt.trim(),
    duration,
    aspectRatio,
    createdAt: new Date().toISOString(),
    videoUrl: null
  };

  jobs.set(id, job);

// Gemini AI generation
setTimeout(async () => {
  const current = jobs.get(id);
  if (!current) return;

  current.status = 'processing';
  jobs.set(id, current);

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt.trim()
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error?.message || 'Gemini API request failed'
      );
    }

    const generatedText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    current.status = 'completed';
    current.videoUrl = null;
    current.generatedText = generatedText;
    jobs.set(id, current);

  } catch (error) {
    console.error('Gemini error:', error);

    current.status = 'failed';
    current.error = error.message;
    jobs.set(id, current);
  }
}, 800);
  res.status(202).json({ jobId: id, status: job.status });
});

app.get('/api/generate/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Generation job not found.' });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`FlowForge backend running at http://localhost:${PORT}`);
});
