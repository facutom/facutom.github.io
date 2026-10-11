/**
 * Junta los feeds de varias redes (X, LinkedIn, ...) en un único data/posts.json.
 *
 * Uso:  node scripts/build-feed.mjs
 * Requiere: fast-xml-parser (el workflow lo instala en tiempo de ejecución:
 *           npm i --no-save fast-xml-parser).
 *
 * Config: feed.config.json  -> { maxItems, sources: [{ network, url }] }
 * Las fuentes con url sin completar ([TODO...]) se omiten.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isConfigured = (url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim());

function toText(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toISO(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function normalizeUrl(url, base) {
  if (!url) return base || '';
  try {
    return new URL(url, base || undefined).toString();
  } catch {
    return String(url);
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function parseXml(xml, network, base) {
  const doc = parser.parse(xml);
  const items = [];

  // RSS 2.0 / RDF
  const rssItems = doc?.rss?.channel?.item ?? doc?.feed?.item ?? doc?.['rdf:RDF']?.item ?? [];
  for (const it of [].concat(rssItems)) {
    const link = normalizeUrl(it.link?.['@_href'] ?? it.link ?? it.guid?.['#text'] ?? it.guid, base);
    items.push({
      network,
      date: toISO(it.pubDate ?? it['dc:date'] ?? it.date),
      text: toText(it.description ?? it['content:encoded'] ?? it.title ?? ''),
      url: link,
      image: extractFirstImage(it['content:encoded'] ?? it.description ?? ''),
    });
  }

  // Atom
  const entries = doc?.feed?.entry ?? [];
  for (const e of [].concat(entries)) {
    const links = [].concat(e.link ?? []);
    const alt = links.find((l) => l['@_rel'] === 'alternate') ?? links[0];
    items.push({
      network,
      date: toISO(e.published ?? e.updated),
      text: toText(e.summary?.['#text'] ?? e.summary ?? e.content?.['#text'] ?? e.content ?? e.title ?? ''),
      url: normalizeUrl(alt?.['@_href'], base),
      image: extractFirstImage(e.content?.['#text'] ?? e.content ?? e.summary ?? ''),
    });
  }

  return items;
}

function extractFirstImage(html = '') {
  if (!html) return '';
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function cleanText(t = '') {
  return String(t)
    .replace(/\s*[—–-]\s*[^—–]*\(@[\w]+\)[^—–]*$/, '')
    .trim();
}

function parseJson(data, network) {
  const arr =
    (Array.isArray(data) && data) ||
    data?.items ||
    data?.posts ||
    data?.entries ||
    [];
  return arr.map((it) => ({
    network,
    date: toISO(it.date_published ?? it.date ?? it.pubDate ?? it.isoDate ?? it.published ?? it.created_at),
    text: cleanText(toText(it.content_text ?? it.text ?? it.description ?? it.content ?? it.summary ?? it.title ?? '')),
    url: it.url ?? it.link ?? it.permalink ?? '',
    image: it.image ?? extractFirstImage(it.content_html ?? it.content ?? it.description ?? ''),
  }));
}

async function fetchSource(source) {
  const { network, url } = source;
  const res = await fetch(url, {
    headers: { 'user-agent': 'facutom.github.io feed builder', accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const type = res.headers.get('content-type') || '';
  const trimmed = body.trim();
  const looksJson = type.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
  const items = looksJson ? parseJson(JSON.parse(trimmed), network) : parseXml(trimmed, network, url);
  // Filtro opcional por URL (p. ej. para quedarse solo con los posts propios y excluir retuits).
  if (source.filter) {
    const re = new RegExp(source.filter, 'i');
    return items.filter((i) => re.test(i.url));
  }
  return items;
}

async function loadFallback() {
  try {
    const data = JSON.parse(await readFile(join(root, 'data/posts.fallback.json'), 'utf8'));
    return Array.isArray(data.posts) ? data.posts : [];
  } catch {
    return [];
  }
}

/**
 * Visualizaciones (views) de X sin API ni token: se leen del HTML server-rendered
 * de la página del post, donde viene `views:{count:"N"}` asociado al rest_id.
 * Es gratis pero frágil; por eso solo se refresca cada VIEWS_REFRESH_HOURS horas
 * y, mientras tanto, se reutilizan los valores ya guardados en data/posts.json.
 */
const VIEWS_REFRESH_HOURS = Number(process.env.VIEWS_REFRESH_HOURS) || 48;
const X_ID = (p) => (String(p?.url || '').match(/status\/(\d+)/) || [])[1];

function extractViews(html, id) {
  const idRe = new RegExp(`rest_id:"${id}"`, 'g');
  let best = null;
  let m;
  while ((m = idRe.exec(html))) {
    const win = html.slice(m.index, m.index + 1500);
    const v = win.match(/views:\$R\[\d+\]=\{count:"(\d+)"\}|views:\{count:"(\d+)"\}/);
    if (!v) continue;
    const n = Number(v[1] ?? v[2]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

async function fetchXViews(id) {
  const res = await fetch(`https://x.com/i/status/${id}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return extractViews(await res.text(), id);
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(join(root, 'data/posts.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function updateViews(posts) {
  const prev = await readPrevious();
  const prevViews = {};
  for (const p of prev?.posts || []) {
    if (typeof p.views === 'number') prevViews[p.url] = p.views;
  }
  const ageMs = prev?.viewsUpdatedAt ? Date.now() - Date.parse(prev.viewsUpdatedAt) : Infinity;
  let out = posts.map((p) => (prevViews[p.url] !== undefined ? { ...p, views: prevViews[p.url] } : p));

  if (ageMs <= VIEWS_REFRESH_HOURS * 3600e3) {
    console.log(`- Views: sin refrescar (hace ${(ageMs / 3600e3).toFixed(1)} h; umbral ${VIEWS_REFRESH_HOURS} h).`);
    return { posts: out, viewsUpdatedAt: prev.viewsUpdatedAt };
  }

  const targets = out.filter((p) => p.network === 'x' && X_ID(p));
  let ok = 0;
  for (const p of targets) {
    const id = X_ID(p);
    try {
      const v = await fetchXViews(id);
      if (typeof v === 'number') {
        p.views = v;
        ok++;
      }
    } catch (err) {
      console.warn(`! Views ${id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`- Views: actualizadas ${ok}/${targets.length} posts de X.`);
  return { posts: out, viewsUpdatedAt: ok > 0 ? new Date().toISOString() : prev?.viewsUpdatedAt || null };
}

async function main() {
  const config = JSON.parse(await readFile(join(root, 'feed.config.json'), 'utf8'));
  const maxItems = Number(config.maxItems) || 30;

  const enabled = (config.sources || []).filter((s) => isConfigured(s.url));
  if (enabled.length === 0) {
    console.log('No hay fuentes configuradas en feed.config.json (todas en [TODO]): se usará el respaldo.');
  }

  const all = [];
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`- ${source.network}: ${items.length} ítems desde ${source.url}`);
      all.push(...items);
    } catch (err) {
      console.warn(`! ${source.network}: no se pudo leer ${source.url} (${err.message})`);
    }
  }

  const seen = new Set();
  let posts = all
    .filter((p) => p.text && p.url)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter((p) => {
      if (seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    })
    .slice(0, maxItems);

  let origin = 'live';
  if (posts.length === 0) {
    posts = (await loadFallback()).slice(0, maxItems);
    origin = 'fallback';
    console.warn(`Sin publicaciones en vivo: se usa el respaldo (${posts.length} ítems).`);
  }

  if (posts.length === 0) {
    console.warn('No hay publicaciones ni respaldo disponible. data/posts.json queda sin cambios.');
    return;
  }

  const viewed = await updateViews(posts);
  posts = viewed.posts;

  const output = {
    _comment: 'Generado automáticamente por scripts/build-feed.mjs (workflow update-feed.yml). No editar a mano: se sobrescribe.',
    generatedAt: new Date().toISOString(),
    origin,
    posts,
  };
  if (viewed.viewsUpdatedAt) output.viewsUpdatedAt = viewed.viewsUpdatedAt;

  await writeFile(join(root, 'data/posts.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`OK: data/posts.json con ${posts.length} publicaciones (origen: ${origin}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
