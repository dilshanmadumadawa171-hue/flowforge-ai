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

  // Test mode: simulate a provider job.
  setTimeout(() => {
    const current = jobs.get(id);
    if (!current) return;
    current.status = 'processing';
    jobs.set(id, current);
  }, 800);

  setTimeout(() => {
    const current = jobs.get(id);
    if (!current) return;
    current.status = 'completed';
    current.videoUrl = null; // Real provider URL will be stored here later.
    jobs.set(id, current);
  }, 2500);

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
