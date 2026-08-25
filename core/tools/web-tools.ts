/**
 * Web tools for agents — search, fetch, and extract content from the internet.
 * Uses public APIs and standard HTTP. No scraping abuse, no bypass.
 */

export interface WebSearchResult { title: string; url: string; snippet: string; }
export interface WebFetchResult { url: string; title: string; text: string; status: number; }

/** Search the web using DuckDuckGo HTML (no API key required). */
export async function webSearch(query: string, maxResults = 8): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecondBrainOS/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo search HTTP ${res.status}`);
  const html = await res.text();
  const results: WebSearchResult[] = [];
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/g;
  const titles: Array<{url:string;title:string}> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const rawUrl = m[1] ?? '';
    const decodedUrl = rawUrl.startsWith('//duckduckgo.com/l/?uddg=')
      ? decodeURIComponent(rawUrl.replace('//duckduckgo.com/l/?uddg=','').split('&')[0] ?? '')
      : rawUrl;
    titles.push({ url: decodedUrl, title: (m[2] ?? '').replace(/<[^>]*>/g,'').trim() });
  }
  const snippets: string[] = [];
  while ((m = snippetRegex.exec(html)) !== null) snippets.push((m[1] ?? '').replace(/<[^>]*>/g,'').trim());
  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    results.push({ title: titles[i]?.title ?? '', url: titles[i]?.url ?? '', snippet: snippets[i] ?? '' });
  }
  return results;
}

/** Fetch a URL and extract readable text content. */
export async function webFetch(url: string): Promise<WebFetchResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecondBrainOS/1.0)' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? url;
  // Extract text from body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
  return { url: res.url || url, title, text, status: res.status };
}

/** Search Google Maps for businesses (public data). */
export async function searchGoogleMaps(query: string, location: string): Promise<WebSearchResult[]> {
  const searchQuery = `${query} ${location} site:google.com/maps OR site:maps.google.com`;
  return webSearch(searchQuery, 5);
}

/** Search LinkedIn for professionals. */
export async function searchLinkedIn(query: string, location: string): Promise<WebSearchResult[]> {
  const searchQuery = `${query} ${location} site:linkedin.com/in`;
  return webSearch(searchQuery, 5);
}

/** Search for professionals on psychology/nutrition directories. */
export async function searchDirectories(profession: string, location: string): Promise<WebSearchResult[]> {
  const queries = [
    `${profession} ${location} site:psicologo.com.br OR site:nutricao.com.br`,
    `${profession} ${location} contato consultório`,
    `${profession} ${location} "atendimento" "telefone" -site:google.com`,
  ];
  const all: WebSearchResult[] = [];
  for (const q of queries) {
    try { all.push(...await webSearch(q, 5)); } catch {}
  }
  return all.slice(0, 15);
}
