export interface SpecializedAgentDefinition { id: string; name: string; department: string; responsibilities: string[]; permissions: string[]; }
export const SPECIALIZED_AGENTS: readonly SpecializedAgentDefinition[] = [
  { id: "manager", name: "Gerente", department: "MANAGER / GESTÃO", responsibilities: ["planejamento", "delegação", "avaliação"], permissions: ["context", "orchestration"] },
  { id: "marketing-agent", name: "Marketing", department: "MARKETING", responsibilities: ["estratégia", "campanhas", "ofertas"], permissions: ["context", "drive_upload"] },
  { id: "designer-agent", name: "Designer", department: "MARKETING", responsibilities: ["briefs", "criativos", "image_generation"], permissions: ["context", "image_generate", "drive_upload"] },
  { id: "social-media-agent", name: "Mídias Sociais", department: "MARKETING", responsibilities: ["calendário", "publicação"], permissions: ["context"] },
  { id: "traffic-agent", name: "Tráfego Pago", department: "MARKETING", responsibilities: ["métricas", "orçamento"], permissions: ["context"] },
  { id: "prospector-agent", name: "Prospector", department: "PROSPECÇÃO", responsibilities: ["qualificação", "pesquisa", "web_search", "google_maps", "linkedin"], permissions: ["context", "web_search", "web_fetch", "google_maps_search", "linkedin_search", "directory_search", "drive_upload"] },
  { id: "research-agent", name: "Pesquisa", department: "PROSPECÇÃO", responsibilities: ["pesquisa", "síntese", "web_search"], permissions: ["context", "web_search", "web_fetch"] },
  { id: "sales-agent-01", name: "Atendente 1", department: "COMERCIAL", responsibilities: ["atendimento", "follow-up"], permissions: ["context"] },
  { id: "sales-agent-02", name: "Atendente 2", department: "COMERCIAL", responsibilities: ["atendimento", "follow-up"], permissions: ["context"] },
  { id: "sales-agent-03", name: "Atendente 3", department: "COMERCIAL", responsibilities: ["atendimento", "follow-up"], permissions: ["context"] },
  { id: "sales-agent-04", name: "Atendente 4", department: "COMERCIAL", responsibilities: ["atendimento", "follow-up"], permissions: ["context"] },
  { id: "engineering-agent", name: "Engenharia", department: "DESENVOLVIMENTO", responsibilities: ["implementação", "testes"], permissions: ["context", "execute"] },
  { id: "developer-01", name: "Developer 01", department: "DESENVOLVIMENTO", responsibilities: ["desenvolvimento paralelo"], permissions: ["context", "execute"] },
  { id: "developer-02", name: "Developer 02", department: "DESENVOLVIMENTO", responsibilities: ["desenvolvimento paralelo"], permissions: ["context", "execute"] },
  { id: "developer-03", name: "Developer 03", department: "DESENVOLVIMENTO", responsibilities: ["desenvolvimento paralelo"], permissions: ["context", "execute"] },
  { id: "developer-04", name: "Developer 04", department: "DESENVOLVIMENTO", responsibilities: ["desenvolvimento paralelo"], permissions: ["context", "execute"] },
  { id: "qa-agent", name: "QA", department: "QUALIDADE", responsibilities: ["validação independente", "rework"], permissions: ["context", "execute", "review"] },
  { id: "integrator-agent", name: "Integrador", department: "INTEGRAÇÃO", responsibilities: ["integração e quality gate final"], permissions: ["context", "execute"] },
  { id: "maintenance-agent", name: "Manutenção", department: "MANUTENÇÃO", responsibilities: ["limpeza", "saúde"], permissions: ["context"] },
];

export interface LeadCandidate { company: string; contact: string | null; website: string | null; source: string; niche: string | null; location: string | null; signals: string[]; score: number; evidence: string[]; phone?: string | null; email?: string | null; instagram?: string | null; linkedin?: string | null; city?: string | null; state?: string | null; country?: string | null; }
export interface ProspectingSource { readonly name: string; search(query: string): Promise<LeadCandidate[]>; }
export class NotConfiguredProspectingSource implements ProspectingSource { readonly name = "not-configured"; async search(_query: string): Promise<LeadCandidate[]> { throw new Error("PROSPECTING_SOURCE_NOT_CONFIGURED"); } }
export interface SocialPlatform { readonly name: string; publish(content: string): Promise<{ status: "NOT_CONFIGURED" | "PUBLISHED"; id?: string }>; }
export class NotConfiguredSocialPlatform implements SocialPlatform { readonly name = "not-configured"; async publish(_content: string): Promise<{ status: "NOT_CONFIGURED" }> { return { status: "NOT_CONFIGURED" }; } }
export interface ImageProvider { generate(prompt: string): Promise<{ status: "IMAGE_PROVIDER_NOT_CONFIGURED" | "GENERATED"; uri?: string }>; }
export class NotConfiguredImageProvider implements ImageProvider { async generate(_prompt: string): Promise<{ status: "IMAGE_PROVIDER_NOT_CONFIGURED" }> { return { status: "IMAGE_PROVIDER_NOT_CONFIGURED" }; } }

export type ArtifactClass = "EPHEMERAL" | "TEMPORARY" | "IMPORTANT" | "PERSISTENT" | "UNKNOWN";
export function classifyMaintenanceArtifact(fileName: string): ArtifactClass { if (/\.tmp$|cache|temp/i.test(fileName)) return "TEMPORARY"; if (/\.md$|brain\.db/i.test(fileName)) return "PERSISTENT"; if (/\.log$|artifact/i.test(fileName)) return "EPHEMERAL"; return "UNKNOWN"; }
export function canDeleteMaintenanceArtifact(classification: ArtifactClass): boolean { return classification === "EPHEMERAL" || classification === "TEMPORARY"; }
