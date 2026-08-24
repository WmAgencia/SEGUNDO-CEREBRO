export interface DeskPosition { x: number; y: number; }
export interface DepartmentArea { id: string; label: string; area: { x: number; y: number; w: number; h: number }; desks: Record<string, DeskPosition>; }

const GRID = 40;
function desk(x: number, y: number): DeskPosition { return { x: x * GRID, y: y * GRID }; }

export const OFFICE_DEPARTMENTS: readonly DepartmentArea[] = [
  { id: "management", label: "GESTÃO", area: { x: 8, y: 0, w: 4, h: 2 }, desks: { manager: desk(9.5, 1) } },
  { id: "marketing", label: "MARKETING", area: { x: 0, y: 3, w: 10, h: 3 }, desks: {
    "marketing-agent": desk(1, 4),
    "designer-agent": desk(3.5, 4),
    "social-media-agent": desk(6, 4),
    "traffic-agent": desk(8.5, 4),
  } },
  { id: "prospeccao", label: "PROSPECÇÃO", area: { x: 11, y: 3, w: 5, h: 3 }, desks: {
    "prospector-agent": desk(12, 4),
    "research-agent": desk(14.5, 4),
  } },
  { id: "comercial", label: "COMERCIAL", area: { x: 0, y: 7, w: 12, h: 3 }, desks: {
    "sales-agent-01": desk(1, 8),
    "sales-agent-02": desk(3.5, 8),
    "sales-agent-03": desk(6, 8),
    "sales-agent-04": desk(8.5, 8),
  } },
  { id: "desenvolvimento", label: "DESENVOLVIMENTO", area: { x: 13, y: 7, w: 5, h: 3 }, desks: {
    "engineering-agent": desk(14.5, 8),
  } },
  { id: "manutencao", label: "MANUTENÇÃO", area: { x: 0, y: 11, w: 5, h: 2 }, desks: {
    "maintenance-agent": desk(1.5, 11.5),
  } },
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
