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
    });
  }

  return items;
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
    date: toISO(it.date ?? it.pubDate ?? it.isoDate ?? it.published ?? it.created_at),
    text: toText(it.description ?? it.content ?? it.text ?? it.title ?? it.summary ?? ''),
    url: it.url ?? it.link ?? it.permalink ?? '',
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
  return looksJson ? parseJson(JSON.parse(trimmed), network) : parseXml(trimmed, network, url);
}

async function main() {
  const config = JSON.parse(await readFile(join(root, 'feed.config.json'), 'utf8'));
  const maxItems = Number(config.maxItems) || 30;

  const enabled = (config.sources || []).filter((s) => isConfigured(s.url));
  if (enabled.length === 0) {
    console.log('No hay fuentes configuradas en feed.config.json (todas en [TODO]). No se modifica data/posts.json.');
    return;
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
  const posts = all
    .filter((p) => p.text && p.url)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter((p) => {
      if (seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    })
    .slice(0, maxItems);

  if (posts.length === 0) {
    console.warn('No se obtuvieron publicaciones. data/posts.json queda sin cambios.');
    return;
  }

  const output = {
    _comment: 'Generado automáticamente por scripts/build-feed.mjs (workflow update-feed.yml). No editar a mano: se sobrescribe.',
    generatedAt: new Date().toISOString(),
    posts,
  };

  await writeFile(join(root, 'data/posts.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`OK: data/posts.json con ${posts.length} publicaciones.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
