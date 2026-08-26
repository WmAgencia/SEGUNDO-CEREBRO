import type { ProspectingSource, LeadCandidate } from "../../agents/specialized.ts";

/**
 * FONTE REAL: OpenStreetMap Overpass API.
 * Legítima (dados abertos ODbL), sem API key, sem browser, roda em container.
 * Retorna estabelecimentos reais (nome, categoria, endereço, telefone, site/rede).
 *
 * ATENÇÃO: respeita rate limits do Overpass (máx ~1 req/4s). Use search() em
 * ciclos e nunca em loop apertado. Para uso em produção, prefira um endpoint
 * próprio de Overpass (overpass-api.de é público e pode falhar sob carga).
 */
export class OverpassSource implements ProspectingSource {
  readonly name = "openstreetmap_overpass";
  private readonly endpoint: string;

  constructor(endpoint = process.env.OVERPASS_ENDPOINT ?? "https://overpass-api.de/api/interpreter") {
    this.endpoint = endpoint;
  }

  /** Mapeia uma categoria amigável para o filtro OSM (shop/amenity/craft). */
  private static oqlFor(niche: string, areaName: string): string {
    const n = niche.toLowerCase();
    if (/barber|barbearia|cabel|sal[ãa]o|salao|hair|beauty|est[ée]tica|estetica|cosmet/.test(n)) {
      return `[out:json][timeout:50];
area["name"="${areaName}"]["admin_level"="8"]->.a;
(node["shop"~"hairdresser|beauty|cosmetics"](area.a);
 node["craft"~"beautician|hairdresser"](area.a);
 node["amenity"~"beauty|tattoo"](area.a););
out body tags center;`;
    }
    if (/dent|odonto|dental/.test(n)) {
      return `[out:json][timeout:50];
area["name"="${areaName}"]["admin_level"="8"]->.a;
(node["amenity"="dentist"](area.a););
out body tags center;`;
    }
    if (/clin|medic|m[ée]dico|medico|health|sa[úu]de|saude/.test(n)) {
      return `[out:json][timeout:50];
area["name"="${areaName}"]["admin_level"="8"]->.a;
(node["amenity"~"clinic|doctors|hospital"](area.a););
out body tags center;`;
    }
    if (/restaur|comida|food|lanch|pizz|bar /.test(n)) {
      return `[out:json][timeout:50];
area["name"="${areaName}"]["admin_level"="8"]->.a;
(node["amenity"~"restaurant|fast_food|cafe"](area.a););
out body tags center;`;
    }
    if (/fit|gym|academia|pilates|yoga/.test(n)) {
      return `[out:json][timeout:50];
area["name"="${areaName}"]["admin_level"="8"]->.a;
(node["leisure"~"fitness_centre"](area.a);
 node["sport"~"fitness|yoga"](area.a););
out body tags center;`;
    }
    // generic shop
    return `[out:json][timeout:50];
area["name"="${areaName}"]["admin_level"="8"]->.a;
(node["shop"](area.a););
out body tags center;`;
  }

  async search(query: string): Promise<LeadCandidate[]> {
    // query esperado no formato "niche em cidade" | "niche cidade"
    const [niche = query, areaName = "Sorocaba"] = query.split(/\s+em\s+/i).map((s) => s.trim());
    const oql = OverpassSource.oqlFor(niche, areaName);
    const res = await fetch(this.endpoint, {
      method: "POST",
      body: "data=" + encodeURIComponent(oql),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "second-brain-prospector/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
    const data = (await res.json()) as {
      elements?: Array<{ tags?: Record<string, string>; lat?: number; lon?: number }>;
    };

    const candidates: LeadCandidate[] = [];
    for (const e of data.elements ?? []) {
      const t = e.tags ?? {};
      const name = t.name;
      if (!name) continue;
      const phone = t.phone ?? t["contact:phone"] ?? null;
      const website = t.website ?? t["contact:website"] ?? null;
      const instagram = t["contact:instagram"] ?? (website && /instagram\.com/.test(website) ? website : null);
      const signals: string[] = [];
      if (!website) {
        signals.push("no_website");
      } else if (!/instagram\.com/.test(website) && !/\."?[a-z]{2,}/.test(website)) {
        signals.push("no_website");
      }
      if (!phone) signals.push("no_phone");
      if (t["addr:street"]) signals.push("has_address");
      const scraped = [
        instagram ? "instagram_ativo" : null,
        phone ? "phone_public" : null,
        website ? "website_public" : null,
      ].filter(Boolean) as string[];
      candidates.push({
        company: name,
        contact: null,
        website,
        source: this.name,
        niche: t.shop ?? t.amenity ?? t.craft ?? t.leisure ?? null,
        location: [t["addr:street"] ?? "", t["addr:city"] ?? areaName].filter(Boolean).join(", "),
        signals,
        score: 0,
        phone: phone,
        email: t.email ?? t["contact:email"] ?? null,
        instagram,
        city: t["addr:city"] ?? areaName,
        state: t["addr:state"] ?? null,
        country: t["addr:country"] ? String(t["addr:country"]).toUpperCase() : "BR",
        evidence: [`${this.name}:${name}`, ...scraped],
      });
    }
    return candidates;
  }
}
