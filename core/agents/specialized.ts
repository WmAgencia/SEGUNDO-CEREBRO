export interface SpecializedAgentDefinition { id: string; name: string; department: string; responsibilities: string[]; permissions: string[]; }
export const SPECIALIZED_AGENTS: readonly SpecializedAgentDefinition[] = [
  { id: "manager", name: "Manager", department: "MANAGER / GESTÃO", responsibilities: ["planning", "delegation", "evaluation"], permissions: ["context", "orchestration"] },
  { id: "marketing-agent", name: "Marketing Agent", department: "MARKETING", responsibilities: ["strategy", "campaigns", "offers"], permissions: ["context"] },
  { id: "designer-agent", name: "Designer Agent", department: "DESIGN", responsibilities: ["briefs", "creative-adaptation"], permissions: ["context"] },
  { id: "social-media-agent", name: "Social Media Agent", department: "SOCIAL MEDIA", responsibilities: ["calendar", "copy", "publishing"], permissions: ["context"] },
  { id: "traffic-agent", name: "Traffic Agent", department: "TRÁFEGO PAGO", responsibilities: ["metrics", "experiments", "budget-review"], permissions: ["context"] },
  { id: "prospector-agent", name: "Prospector Agent", department: "PROSPECÇÃO", responsibilities: ["qualification", "deduplication"], permissions: ["context"] },
  { id: "commercial-agent", name: "Commercial Agent", department: "COMERCIAL", responsibilities: ["queue", "follow-up"], permissions: ["context"] },
  { id: "engineering-agent", name: "Engineering Agent", department: "DESENVOLVIMENTO", responsibilities: ["implementation", "testing"], permissions: ["context", "execute"] },
  { id: "research-agent", name: "Research Agent", department: "PESQUISA / INTELIGÊNCIA", responsibilities: ["research", "synthesis"], permissions: ["context"] },
  { id: "maintenance-agent", name: "Maintenance Agent", department: "MANUTENÇÃO", responsibilities: ["cleanup", "health"], permissions: ["context"] },
];

export interface LeadCandidate { company: string; contact: string | null; website: string | null; source: string; niche: string | null; location: string | null; signals: string[]; score: number; evidence: string[]; }
export interface ProspectingSource { readonly name: string; search(query: string): Promise<LeadCandidate[]>; }
export class NotConfiguredProspectingSource implements ProspectingSource { readonly name = "not-configured"; async search(_query: string): Promise<LeadCandidate[]> { throw new Error("PROSPECTING_SOURCE_NOT_CONFIGURED"); } }
export interface SocialPlatform { readonly name: string; publish(content: string): Promise<{ status: "NOT_CONFIGURED" | "PUBLISHED"; id?: string }>; }
export class NotConfiguredSocialPlatform implements SocialPlatform { readonly name = "not-configured"; async publish(_content: string): Promise<{ status: "NOT_CONFIGURED" }> { return { status: "NOT_CONFIGURED" }; } }
export interface ImageProvider { generate(prompt: string): Promise<{ status: "IMAGE_PROVIDER_NOT_CONFIGURED" | "GENERATED"; uri?: string }>; }
export class NotConfiguredImageProvider implements ImageProvider { async generate(_prompt: string): Promise<{ status: "IMAGE_PROVIDER_NOT_CONFIGURED" }> { return { status: "IMAGE_PROVIDER_NOT_CONFIGURED" }; } }

export type ArtifactClass = "EPHEMERAL" | "TEMPORARY" | "IMPORTANT" | "PERSISTENT" | "UNKNOWN";
export function classifyMaintenanceArtifact(fileName: string): ArtifactClass { if (/\.tmp$|cache|temp/i.test(fileName)) return "TEMPORARY"; if (/\.md$|brain\.db/i.test(fileName)) return "PERSISTENT"; if (/\.log$|artifact/i.test(fileName)) return "EPHEMERAL"; return "UNKNOWN"; }
export function canDeleteMaintenanceArtifact(classification: ArtifactClass): boolean { return classification === "EPHEMERAL" || classification === "TEMPORARY"; }
