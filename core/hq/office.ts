export interface DeskPosition { x: number; y: number; }
export interface DepartmentArea { id: string; label: string; area: { x: number; y: number; w: number; h: number }; desks: Record<string, DeskPosition>; }

const GRID = 40;

function desk(x: number, y: number): DeskPosition { return { x: x * GRID, y: y * GRID }; }

export const OFFICE_DEPARTMENTS: readonly DepartmentArea[] = [
  { id: "management", label: "MANAGER / GESTÃO", area: { x: 8, y: 0, w: 4, h: 2 }, desks: { manager: desk(9.5, 1) } },
  { id: "marketing", label: "MARKETING", area: { x: 0, y: 3, w: 5, h: 3 }, desks: { "marketing-agent": desk(1, 4), "content-agent": desk(3, 4) } },
  { id: "design", label: "DESIGN", area: { x: 6, y: 3, w: 4, h: 3 }, desks: { "designer-agent": desk(7, 4) } },
  { id: "social-media", label: "SOCIAL MEDIA", area: { x: 11, y: 3, w: 4, h: 3 }, desks: { "social-media-agent": desk(12, 4) } },
  { id: "trafego-pago", label: "TRÁFEGO PAGO", area: { x: 16, y: 3, w: 4, h: 3 }, desks: { "traffic-agent": desk(17, 4) } },
  { id: "prospeccao", label: "PROSPECÇÃO", area: { x: 0, y: 7, w: 5, h: 3 }, desks: { "prospector-agent": desk(1, 8), "research-agent": desk(3, 8) } },
  { id: "comercial", label: "COMERCIAL", area: { x: 6, y: 7, w: 9, h: 3 }, desks: { "commercial-agent": desk(7, 8), "sales-agent-02": desk(9, 8), "sales-agent-03": desk(11, 8), "sales-agent-04": desk(13, 8) } },
  { id: "desenvolvimento", label: "DESENVOLVIMENTO", area: { x: 16, y: 7, w: 4, h: 3 }, desks: { "engineering-agent": desk(17, 8) } },
  { id: "manutencao", label: "MANUTENÇÃO", area: { x: 0, y: 11, w: 5, h: 2 }, desks: { "maintenance-agent": desk(1, 11.5) } },
];

export function departmentForAgent(agentId: string): DepartmentArea | undefined {
  for (const department of OFFICE_DEPARTMENTS) if (department.desks[agentId]) return department;
  return undefined;
}

export function deskPosition(agentId: string): DeskPosition | null {
  return departmentForAgent(agentId)?.desks[agentId] ?? null;
}

export function officeBounds(): { w: number; h: number } {
  let w = 0; let h = 0;
  for (const department of OFFICE_DEPARTMENTS) {
    w = Math.max(w, department.area.x + department.area.w);
    h = Math.max(h, department.area.y + department.area.h);
  }
  return { w: w * GRID, h: h * GRID };
}
