// One-time migration of the app's authored first-party content. Uses the owner's
// existing Wrangler login; no admin session, API token, or secret is embedded.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalogContent } from '../src/lib/catalogValidation.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--apply') options.set(key, true);
  else if (key.startsWith('--') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options.set(key, process.argv[++i]);
  else throw new Error(`Unknown or incomplete argument: ${key}`);
}
const directory = path.resolve(options.get('--output') || '/tmp/learnalert-catalog-bootstrap');
const planFile = path.join(directory, 'plan.json');
const actor = 'bundled-catalog-bootstrap';
const bucket = 'learnalert-deck-assets', database = 'learnalert-community';
const sqlValue = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const digest = data => createHash('sha256').update(data).digest('hex');
const atlasNames = ['apple','banana','orange','grapes','cat','dog','rabbit','bird','coffee','water','rice','milk','book','bag','chair','clock'];
async function dimensions(file) {
  const { stdout } = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!(width > 1 && height > 1)) throw new Error(`Missing or placeholder artwork: ${file}`);
  return { width, height };
}
async function prepare() {
  if (!options.get('--input') || !options.get('--app-source')) throw new Error('Prepare: node scripts/bootstrap-catalog.mjs --input <export.json> --app-source <LearnAlert checkout> [--output <directory>]. Then rerun with --output <directory> --apply.');
  const input = JSON.parse(await readFile(path.resolve(options.get('--input')), 'utf8'));
  if (input.schemaVersion !== 1 || !Array.isArray(input.items) || !input.items.length) throw new Error('Expected schemaVersion 1 and nonempty items.');
  await mkdir(directory, { recursive: true });
  // Never silently replace a partially uploaded migration plan with new IDs.
  try { await readFile(planFile); throw new Error(`A plan already exists at ${planFile}. Reuse it with --apply or choose a new output directory.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const app = path.resolve(options.get('--app-source'), 'LearnAlert');
  const atlas = path.join(app, 'CourseVocabularyAtlas.png');
  const atlasSize = await dimensions(atlas);
  const items = [], uploads = [], statements = [], seen = new Set();
  const stamp = Math.floor(Date.now() / 1000);
  for (const source of input.items) {
    if (seen.has(source.id)) throw new Error(`Duplicate item: ${source.id}`);
    seen.add(source.id);
    validateCatalogContent(source.kind, source.document, source.id, { publish: true });
    const document = structuredClone(source.document), references = new Map();
    function collect(value) {
      if (typeof value === 'string' && (value.startsWith('course-vocab-') || /^koreanimages\/[A-Za-z0-9_-]+\.(png|jpe?g)$/.test(value))) references.set(value, null);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    }
    collect(document);
    const media = [];
    for (const name of references.keys()) {
      const id = randomUUID(), file = path.join(directory, `${id}.png`);
      if (name.startsWith('course-vocab-')) {
        const index = atlasNames.indexOf(name.slice('course-vocab-'.length));
        if (index < 0) throw new Error(`Unknown atlas tile: ${name}`);
        const side = atlasSize.width / 4;
        if (atlasSize.width !== atlasSize.height) throw new Error('Expected the app’s 4×4 square vocabulary atlas.');
        await exec('/usr/bin/sips', ['-c', String(Math.ceil(side)), String(Math.ceil(side)), '--cropOffset', String(Math.floor(Math.floor(index / 4) * side)), String(Math.floor(index % 4 * side)), atlas, '--out', file]);
      } else {
        await copyFile(path.join(app, name), file);
      }
      await dimensions(file);
      const bytes = await readFile(file), key = `catalog/media/${source.id}/${id}.png`;
      references.set(name, `catalog:${id}`);
      media.push({ id, key, byteSize: bytes.length });
      uploads.push({ file: path.basename(file), key, contentType: 'image/png', sha256: digest(bytes) });
    }
    function rewrite(value) {
      if (typeof value === 'string') return references.get(value) ?? value;
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
      return value;
    }
    const portable = rewrite(document);
    const validated = validateCatalogContent(source.kind, portable, source.id, { publish: true });
    const key = `catalog/documents/${source.id}/${randomUUID()}.json`;
    const file = `${source.id}.json`, bytes = Buffer.from(JSON.stringify(portable));
    await writeFile(path.join(directory, file), bytes);
    uploads.push({ file, key, contentType: 'application/json', sha256: digest(bytes) });
    items.push({ id: source.id, key });
    const columns = 'id,kind,title,subtitle,language,color_hex,status,revision,draft_key,published_key,published_revision,published_title,published_at,sort_order,summary_json,created_at,updated_at,updated_by';
    const values = [source.id,source.kind,validated.title,portable.levelTag ?? portable.subcategory ?? '',portable.language ?? null,portable.colorHex,'published',1,key,key,1,validated.title,stamp,items.length - 1,JSON.stringify(validated.summary),stamp,stamp,actor];
    statements.push(`INSERT OR IGNORE INTO managed_catalog(${columns}) VALUES(${values.map(sqlValue)});`);
    statements.push(`INSERT OR IGNORE INTO managed_catalog_revisions(catalog_id,revision,action,content_key,actor,note,created_at,published) VALUES(${[source.id,1,'publish',key,actor,'Exact bundled app content with portable artwork',stamp,1].map(sqlValue)});`);
    for (const asset of media) {
      statements.push(`INSERT OR IGNORE INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) VALUES(${[asset.id,source.id,asset.key,'image/png',asset.byteSize,stamp,actor].map(sqlValue)});`);
      statements.push(`INSERT OR IGNORE INTO managed_catalog_public_media(catalog_id,media_id) VALUES(${[source.id,asset.id].map(sqlValue)});`);
    }
    statements.push(`INSERT OR IGNORE INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(${[randomUUID(),actor,'catalog_bootstrap',source.id,JSON.stringify({ revision:1,...validated.summary }),stamp].map(sqlValue)});`);
  }
  const expectedItems = items.map(item => `EXISTS(SELECT 1 FROM managed_catalog WHERE id=${sqlValue(item.id)} AND draft_key=${sqlValue(item.key)} AND revision=1 AND updated_by=${sqlValue(actor)})`).join(' AND ');
  statements.push(`UPDATE managed_catalog_state SET revision=MAX(revision,${items.length}),initialized=1 WHERE id=1 AND (SELECT COUNT(*) FROM managed_catalog)=${items.length} AND ${expectedItems};`);
  await writeFile(path.join(directory, 'seed.sql'), statements.join('\n') + '\n');
  const plan = { schemaVersion:1, actor, bucket, database, items, uploads, createdAt:stamp };
  await writeFile(planFile, JSON.stringify(plan, null, 2) + '\n');
  console.log(`Prepared ${items.length} exact catalog documents and ${uploads.length - items.length} portable images. No remote changes. Plan: ${planFile}`);
  return plan;
}
async function wrangler(args) {
  for (let attempt = 1; ; attempt++) {
    try { return await exec(path.join(root, 'node_modules/.bin/wrangler'), args, { cwd:root, maxBuffer:8*1024*1024 }); }
    catch (error) {
      // The prepared object keys and INSERT OR IGNORE seed are idempotent.
      // Retry transient transport failures without recreating the migration plan.
      if (attempt >= 4 || !/fetch failed|ECONNRESET|ETIMEDOUT|connectivity issue/i.test(`${error.message}\n${error.stderr || ''}`)) throw error;
      console.log(`Retrying Cloudflare transport (${attempt}/3)…`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}
async function apply(plan) {
  if (plan.schemaVersion !== 1 || plan.bucket !== bucket || plan.database !== database || plan.actor !== actor) throw new Error('Unrecognized bootstrap plan.');
  for (const upload of plan.uploads) {
    if (path.basename(upload.file) !== upload.file || !upload.key.startsWith('catalog/')) throw new Error('Invalid plan path.');
    if (digest(await readFile(path.join(directory, upload.file))) !== upload.sha256) throw new Error(`Prepared bytes changed: ${upload.file}`);
  }
  const { stdout } = await wrangler(['d1','execute',database,'--remote','--json','--command','SELECT id,draft_key,revision,updated_by FROM managed_catalog']);
  const rows = JSON.parse(stdout).flatMap(result => result.results || []);
  for (const row of rows) {
    const intended = plan.items.find(item => item.id === row.id);
    if (!intended || row.draft_key !== intended.key || row.revision !== 1 || row.updated_by !== actor) throw new Error('The catalog already has content or edits. Refusing to overwrite it. Use /admin for subsequent imports.');
  }
  let completed = 0;
  const queue = [...plan.uploads];
  async function worker() {
    for (;;) {
      const upload = queue.shift(); if (!upload) return;
      await wrangler(['r2','object','put',`${bucket}/${upload.key}`,'--remote','--file',path.join(directory,upload.file),'--content-type',upload.contentType]);
      console.log(`Uploaded ${++completed}/${plan.uploads.length}: ${upload.file}`);
    }
  }
  await Promise.all([worker(),worker(),worker()]);
  await wrangler(['d1','execute',database,'--remote','--file',path.join(directory,'seed.sql'),'--yes']);
  const state = await wrangler(['d1','execute',database,'--remote','--json','--command','SELECT initialized FROM managed_catalog_state WHERE id=1']);
  if (!JSON.parse(state.stdout).some(result => result.results?.[0]?.initialized === 1)) throw new Error('Initialization did not complete. Inspect the prepared plan and remote rows before continuing.');
  console.log('Catalog initialized. Existing community decks, profiles, moderation, and personal study progress were not modified.');
}
try {
  if (options.get('--apply')) await apply(JSON.parse(await readFile(planFile, 'utf8')));
  else await prepare();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
