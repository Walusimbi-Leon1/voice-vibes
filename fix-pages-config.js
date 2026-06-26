import { readFileSync, writeFileSync } from 'fs';
const path = 'dist/server/wrangler.json';
try {
  const config = JSON.parse(readFileSync(path, 'utf-8'));
  delete config.main;
  delete config.assets;
  delete config.$schema;
  writeFileSync(path, JSON.stringify(config, null, 2));
  console.log('✅ Fixed pages config: removed main/assets keys');
} catch (e) {
  console.error('Failed to fix pages config:', e.message);
}
