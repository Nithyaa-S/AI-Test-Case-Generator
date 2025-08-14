import { Router } from 'express';
import OpenAI from 'openai';

const router = Router();

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function fallbackSummaries(files, framework = 'jest') {
  const joined = files.map((f) => f.path).slice(0, 3).join(', ');
  return [
    {
      id: 'stub-1',
      title: `Basic render and export checks (${framework})`,
      framework,
      description: `Ensure modules render or export expected functions for: ${joined}.`,
      targetFiles: files.map((f) => f.path),
    },
    {
      id: 'stub-2',
      title: `Edge cases and error handling (${framework})`,
      framework,
      description: `Cover boundary conditions and thrown errors when invalid inputs are provided.`,
      targetFiles: files.map((f) => f.path),
    },
  ];
}

// POST /api/ai/summaries { files: [{ path, content }], framework? }
router.post('/summaries', async (req, res) => {
  try {
    const { files = [], framework = 'jest' } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'files[] required' });
    const client = getClient();

    if (!client) {
      return res.json({ summaries: fallbackSummaries(files, framework), provider: 'fallback' });
    }

    const system = `You are a senior test engineer. Given multiple source files, propose a set of high-impact test case summaries.
Return strictly the following JSON schema: { "summaries": [ { "id": string, "title": string, "framework": string, "description": string, "targetFiles": string[] } ] }.`;

    const user = `Framework: ${framework}\nFiles:\n${files.map((f) => `- ${f.path}\n\n${f.content.substring(0, 4000)}`).join('\n\n---\n\n')}\n\nGenerate 3-5 concise summaries appropriate for a single test suite covering the selected files.`;

    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    });

    const text = resp.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { summaries: fallbackSummaries(files, framework) }; }
    res.json({ ...parsed, provider: 'openai' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/generate { summary: {title, framework, description, targetFiles}, files: [{path, content}], languageHint? }
router.post('/generate', async (req, res) => {
  try {
    const { summary, files = [], languageHint } = req.body || {};
    if (!summary || !Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'summary and files required' });
    const client = getClient();

    const fallback = () => {
      const header = `// Test suite: ${summary.title}\n// Framework: ${summary.framework}\n`;
      if ((summary.framework || '').toLowerCase().includes('jest')) {
        return header + `\ndescribe('${summary.title}', () => {\n  it('should run a basic sanity check', () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`;
      }
      return header + `\n# pytest sanity test\n\n def test_sanity():\n    assert 1 + 1 == 2\n`;
    };

    if (!client) return res.json({ code: fallback(), provider: 'fallback' });

    const system = `You generate high-quality, runnable test code. Respond with ONLY code, no explanations.`;
    const user = `Write tests for the following summary and files. Prefer clean, idiomatic code.\n\nSummary:\n${JSON.stringify(summary, null, 2)}\n\nFiles:\n${files.map((f) => `// ${f.path}\n${f.content.substring(0, 6000)}`).join('\n\n')}`;

    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    });
    const code = resp.choices?.[0]?.message?.content || fallback();
    res.json({ code, provider: 'openai' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;


