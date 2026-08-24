export interface DeskPosition { x: number; y: number; }
export interface DepartmentArea { id: string; label: string; area: { x: number; y: number; w: number; h: number }; desks: Record<string, DeskPosition>; door?: { side: 'bottom'|'top'|'left'|'right'; offset: number }; }

const GRID = 40;
function desk(x: number, y: number): DeskPosition { return { x: x * GRID, y: y * GRID }; }

export const OFFICE_DEPARTMENTS: readonly DepartmentArea[] = [
  { id: "management", label: "GESTÃO", area: { x: 1, y: 1, w: 5, h: 2 }, desks: { manager: desk(3, 2) }, door: { side: 'bottom', offset: .5 } },
  { id: "meeting", label: "SALA DE REUNIÃO", area: { x: 7, y: 1, w: 6, h: 3 }, desks: {}, door: { side: 'bottom', offset: .5 } },
  { id: "marketing", label: "MARKETING", area: { x: 1, y: 4, w: 10, h: 3 }, desks: {
    "marketing-agent": desk(2, 5),
    "designer-agent": desk(4.5, 5),
    "social-media-agent": desk(7, 5),
    "traffic-agent": desk(9.5, 5),
  }, door: { side: 'bottom', offset: .3 } },
  { id: "prospeccao", label: "PROSPECÇÃO", area: { x: 12, y: 4, w: 5, h: 3 }, desks: {
    "prospector-agent": desk(13, 5),
    "research-agent": desk(15.5, 5),
  }, door: { side: 'bottom', offset: .5 } },
  { id: "comercial", label: "COMERCIAL", area: { x: 1, y: 8, w: 12, h: 3 }, desks: {
    "sales-agent-01": desk(2, 9),
    "sales-agent-02": desk(4.5, 9),
    "sales-agent-03": desk(7, 9),
    "sales-agent-04": desk(9.5, 9),
  }, door: { side: 'top', offset: .7 } },
  { id: "desenvolvimento", label: "DESENVOLVIMENTO", area: { x: 14, y: 8, w: 5, h: 3 }, desks: {
    "engineering-agent": desk(16, 9),
  }, door: { side: 'left', offset: .5 } },
  { id: "manutencao", label: "MANUTENÇÃO", area: { x: 1, y: 12, w: 4, h: 2 }, desks: {
    "maintenance-agent": desk(2.5, 13),
  }, door: { side: 'top', offset: .5 } },
  { id: "social", label: "ÁREA SOCIAL", area: { x: 6, y: 12, w: 8, h: 2 }, desks: {} },
];

export function departmentForAgent(agentId: string): DepartmentArea | undefined {
  for (const department of OFFICE_DEPARTMENTS) if (department.desks[agentId]) return department;
  return undefined;
}

export function deskPosition(agentId: string): DeskPosition | null {
  return departmentForAgent(agentId)?.desks[agentId] ?? null;
}

export function meetingRoomPosition(): DeskPosition {
  const room = OFFICE_DEPARTMENTS.find(d => d.id === 'meeting');
  if (!room) return { x: 400, y: 80 };
  return { x: (room.area.x + room.area.w / 2) * GRID, y: (room.area.y + room.area.h / 2) * GRID };
}

export function officeBounds(): { w: number; h: number } {
  let w = 0; let h = 0;
  for (const department of OFFICE_DEPARTMENTS) {
    w = Math.max(w, department.area.x + department.area.w + 1);
    h = Math.max(h, department.area.y + department.area.h + 1);
  }
  return { w: w * GRID, h: h * GRID };
}
