export interface DeskPosition { x: number; y: number; }
export interface DecorItem { type: string; x: number; y: number; }
export interface DepartmentArea {
  id: string; label: string;
  area: { x: number; y: number; w: number; h: number };
  floorColor: string;
  desks: Record<string, DeskPosition>;
  decor: DecorItem[];
  door?: { side: 'bottom'|'top'|'left'|'right'; offset: number };
}

const G = 40;
function d(x: number, y: number): DeskPosition { return { x: x * G, y: y * G }; }
function dec(type: string, x: number, y: number): DecorItem { return { type, x: x * G, y: y * G }; }

export const OFFICE_DEPARTMENTS: readonly DepartmentArea[] = [
  {
    id: 'management', label: 'GESTÃO', area: { x: 1, y: 1, w: 5, h: 3 }, floorColor: '#1a2228',
    desks: { manager: d(3, 2.5) },
    decor: [dec('plant', 1.5, 1.5), dec('whiteboard', 4.5, 1.5), dec('bookshelf', 1.5, 3.5)],
    door: { side: 'bottom', offset: .5 },
  },
  {
    id: 'server', label: 'SECOND BRAIN', area: { x: 7, y: 1, w: 3, h: 3 }, floorColor: '#0d1520',
    desks: {},
    decor: [dec('server-rack', 7.5, 1.5), dec('server-rack', 8.5, 1.5), dec('server-rack', 7.5, 3), dec('server-rack', 8.5, 3)],
    door: { side: 'bottom', offset: .5 },
  },
  {
    id: 'marketing', label: 'MARKETING', area: { x: 11, y: 1, w: 10, h: 4 }, floorColor: '#1e1a24',
    desks: {
      'marketing-agent': d(12, 3), 'designer-agent': d(14.5, 3),
      'social-media-agent': d(17, 3), 'traffic-agent': d(19.5, 3),
    },
    decor: [dec('plant', 11.5, 1.5), dec('plant', 20.5, 1.5), dec('whiteboard', 15, 1.5), dec('bookshelf', 11.5, 4.5), dec('plant', 20.5, 4.5)],
    door: { side: 'bottom', offset: .3 },
  },
  {
    id: 'prospeccao', label: 'PROSPECÇÃO', area: { x: 1, y: 5, w: 6, h: 4 }, floorColor: '#1a2018',
    desks: { 'prospector-agent': d(2, 6.5), 'research-agent': d(4.5, 6.5) },
    decor: [dec('plant', 1.5, 5.5), dec('bookshelf', 6, 5.5), dec('plant', 6, 8.5)],
    door: { side: 'right', offset: .5 },
  },
  {
    id: 'comercial', label: 'COMERCIAL', area: { x: 8, y: 6, w: 13, h: 4 }, floorColor: '#201a1a',
    desks: {
      'sales-agent-01': d(9, 7.5), 'sales-agent-02': d(11.5, 7.5),
      'sales-agent-03': d(14, 7.5), 'sales-agent-04': d(16.5, 7.5),
    },
    decor: [dec('computer', 12.5, 9.4), dec('plant', 8.5, 6.5), dec('whiteboard', 13, 6.5), dec('plant', 20.5, 6.5), dec('plant', 8.5, 9.5), dec('bookshelf', 19, 9.5)],
    door: { side: 'top', offset: .5 },
  },
  {
    id: 'desenvolvimento', label: 'DESENVOLVIMENTO', area: { x: 1, y: 10, w: 6, h: 3 }, floorColor: '#161e22',
    desks: { 'engineering-agent': d(2.5, 11.5) },
    decor: [dec('server-rack', 5, 10.5), dec('plant', 1.5, 12.5), dec('bookshelf', 5, 12.5)],
    door: { side: 'top', offset: .5 },
  },
  {
    id: 'meeting', label: 'SALA DE REUNIÃO', area: { x: 8, y: 11, w: 6, h: 3 }, floorColor: '#1c1a1e',
    desks: {},
    decor: [dec('meeting-table', 10, 12.5), dec('whiteboard', 10, 11), dec('plant', 8.5, 11), dec('plant', 13.5, 13.5)],
    door: { side: 'left', offset: .5 },
  },
  {
    id: 'manutencao', label: 'MANUTENÇÃO', area: { x: 15, y: 11, w: 4, h: 3 }, floorColor: '#1e1e1a',
    desks: { 'maintenance-agent': d(16.5, 12.5) },
    decor: [dec('plant', 15.5, 11), dec('server-rack', 18, 11), dec('plant', 18.5, 13.5)],
    door: { side: 'left', offset: .5 },
  },
  {
    id: 'social', label: 'ÁREA SOCIAL', area: { x: 8, y: 15, w: 11, h: 2 }, floorColor: '#1e1c16',
    desks: {},
    decor: [dec('sofa', 9, 15.5), dec('sofa', 12, 15.5), dec('coffee-table', 10.5, 16.5), dec('plant', 14, 15.5), dec('plant', 18, 15.5), dec('plant', 8.5, 16.5)],
  },
];

export function departmentForAgent(agentId: string): DepartmentArea | undefined {
  for (const dept of OFFICE_DEPARTMENTS) if (dept.desks[agentId]) return dept;
  return undefined;
}
export function deskPosition(agentId: string): DeskPosition | null {
  return departmentForAgent(agentId)?.desks[agentId] ?? null;
}
export function meetingRoomCenter(): DeskPosition {
  const room = OFFICE_DEPARTMENTS.find(d => d.id === 'meeting');
  if (!room) return { x: 400, y: 500 };
  return { x: (room.area.x + room.area.w / 2) * G, y: (room.area.y + room.area.h / 2) * G };
}
export function serverRoomCenter(): DeskPosition {
  const room = OFFICE_DEPARTMENTS.find(d => d.id === 'server');
  if (!room) return { x: 360, y: 80 };
  return { x: (room.area.x + room.area.w / 2) * G, y: (room.area.y + room.area.h / 2) * G };
}
export function officeBounds(): { w: number; h: number } {
  let w = 0, h = 0;
  for (const dept of OFFICE_DEPARTMENTS) { w = Math.max(w, dept.area.x + dept.area.w + 1); h = Math.max(h, dept.area.y + dept.area.h + 1); }
  return { w: w * G, h: h * G };
}
