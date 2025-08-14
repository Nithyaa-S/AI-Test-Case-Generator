import { Router } from 'express';
import axios from 'axios';

const router = Router();

function getGithubToken(req) {
  const headerToken = req.header('x-github-token');
  return headerToken || process.env.GITHUB_TOKEN || '';
}

function githubClient(token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return axios.create({ baseURL: 'https://api.github.com', headers });
}

// GET /api/github/tree?owner=&repo=&ref=main
router.get('/tree', async (req, res) => {
  try {
    const { owner, repo, ref = 'main' } = req.query;
    if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });
    const token = getGithubToken(req);
    const gh = githubClient(token);

    // Resolve ref to a commit sha
    const refResp = await gh.get(`/repos/${owner}/${repo}/git/refs/heads/${ref}`).catch(() => null);
    let commitSha = ref;
    if (refResp?.data?.object?.sha) commitSha = refResp.data.object.sha;

    const treeResp = await gh.get(`/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`);
    const files = (treeResp.data?.tree || [])
      .filter((n) => n.type === 'blob')
      .map((n) => ({ path: n.path, size: n.size, sha: n.sha }));
    res.json({ ref: commitSha, files });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.message, details: err.response?.data });
  }
});

// GET /api/github/file?owner=&repo=&path=&ref=shaOrBranch
router.get('/file', async (req, res) => {
  try {
    const { owner, repo, path, ref = 'main' } = req.query;
    if (!owner || !repo || !path) return res.status(400).json({ error: 'owner, repo, path required' });
    const token = getGithubToken(req);
    const gh = githubClient(token);
    const resp = await gh.get(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(resp.data)) return res.status(400).json({ error: 'Path is a directory' });
    const content = Buffer.from(resp.data.content, 'base64').toString('utf8');
    res.json({ path, encoding: 'utf8', content, sha: resp.data.sha });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.message, details: err.response?.data });
  }
});

// POST /api/github/pr
// body: { owner, repo, base: 'main', branch: 'tests/ai-<timestamp>', files: [{ path, content }], title, body }
router.post('/pr', async (req, res) => {
  try {
    const { owner, repo, base = 'main', branch, files, title, body } = req.body || {};
    
    // Enhanced validation
    if (!owner || !repo) {
      return res.status(400).json({ error: 'Owner and repository are required' });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Files array is required and must not be empty' });
    }
    if (!files.every(f => f.path && f.content)) {
      return res.status(400).json({ error: 'Each file must have path and content' });
    }
    
    const targetBranch = branch || `tests/ai-${Date.now()}`;
    const token = getGithubToken(req);
    
    if (!token) {
      return res.status(400).json({ 
        error: 'GitHub token required to create PR',
        details: 'Please provide a valid GitHub personal access token with repo permissions'
      });
    }
    
    const gh = githubClient(token);

    try {
      // 1. Verify repository access and get base ref sha
      const baseRef = await gh.get(`/repos/${owner}/${repo}/git/refs/heads/${base}`).catch(async () => {
        // fallback to /git/refs/heads/{base}
        return gh.get(`/repos/${owner}/${repo}/git/refs/heads/${base}`);
      });
      
      const baseSha = baseRef.data.object?.sha || baseRef.data.sha;
      if (!baseSha) {
        throw new Error(`Could not resolve base branch '${base}'`);
      }

      // 2. Create new branch ref
      await gh.post(`/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${targetBranch}`,
        sha: baseSha,
      });

      // 3. Create/Update files on the new branch via Contents API
      for (const f of files) {
        try {
          await gh.put(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}`, {
            message: `chore(tests): add AI-generated tests for ${f.path}`,
            content: Buffer.from(f.content, 'utf8').toString('base64'),
            branch: targetBranch,
          });
        } catch (fileError) {
          console.error(`Failed to create file ${f.path}:`, fileError.response?.data || fileError.message);
          throw new Error(`Failed to create file ${f.path}: ${fileError.response?.data?.message || fileError.message}`);
        }
      }

      // 4. Create PR
      const pr = await gh.post(`/repos/${owner}/${repo}/pulls`, {
        title: title || 'AI-generated test cases',
        head: targetBranch,
        base,
        body: body || `This PR adds AI-generated test cases for the following files:\n\n${files.map(f => `- \`${f.path}\``).join('\n')}\n\nGenerated using AI Test Case Generator.`,
      });

      res.json({ 
        pr: pr.data,
        message: 'Pull request created successfully',
        branch: targetBranch,
        filesCount: files.length
      });
      
    } catch (ghError) {
      // Handle GitHub API specific errors
      if (ghError.response?.status === 401) {
        return res.status(401).json({ 
          error: 'GitHub authentication failed',
          details: 'Please check your GitHub token has the correct permissions (repo scope required)'
        });
      }
      if (ghError.response?.status === 403) {
        return res.status(403).json({ 
          error: 'Repository access denied',
          details: 'Your GitHub token does not have permission to access this repository'
        });
      }
      if (ghError.response?.status === 404) {
        return res.status(404).json({ 
          error: 'Repository not found',
          details: `Repository '${owner}/${repo}' not found or you don't have access to it`
        });
      }
      
      throw ghError;
    }
    
  } catch (err) {
    console.error('PR creation error:', err);
    const status = err.response?.status || 500;
    res.status(status).json({ 
      error: err.message || 'Failed to create pull request',
      details: err.response?.data || 'Unknown error occurred',
      status: status
    });
  }
});

export default router;


