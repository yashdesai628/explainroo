// API keys come from the environment or from a .env file in the project
// folder or the explainroo folder. Git ignores .env.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './server.js';

function readEnvFile(file, name) {
  if (!fs.existsSync(file)) return null;
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = re.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim() || null;
  }
  return null;
}

export function findKey(name, projectDir) {
  if (process.env[name]) return process.env[name];
  return (projectDir && readEnvFile(path.join(projectDir, '.env'), name)) || readEnvFile(path.join(ROOT, '.env'), name);
}
