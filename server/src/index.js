import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import githubRouter from './routes/github.js';
import aiRouter from './routes/ai.js';

dotenv.config();

const app = express();
app.use(express.json({ limit: '5mb' }));

// Completely open CORS for development
app.use(cors());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/github', githubRouter);
app.use('/api/ai', aiRouter);

const port = Number(process.env.PORT || 5001);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});


