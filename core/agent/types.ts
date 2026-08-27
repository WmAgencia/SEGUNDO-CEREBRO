/**
 * Core types for the simplified Second Brain agent architecture
 */

// Agent state and modes
export type AgentMode = 'CHAT' | 'PLAN' | 'EXECUTE';

export interface AgentState {
  mode: AgentMode;
  sessionId: string;
  context: CompiledContext;
  currentPlan?: Plan;
  pendingConfirmation?: ConfirmationRequest;
  backgroundRuns: Map<string, BackgroundRun>;
}

// Context types
export interface CompiledContext {
  subject: string;
  entityId: string | null;
  resolvedBy: ResolveMethod | null;
  entityType: string | null;
  status: string | null;
  summary: string | null;
  aliases: string[];
  relatedEntities: RelatedEntityInfo[];
  decisions: Array<{ id: string; title: string; status: string | null }>;
  procedures: Array<{ id: string; title: string; status: string | null }>;
  recentEvents: TimelineEntryLite[];
  documents: DocumentRef[];
  sources: Array<{ sourceType: string; location: string }>;
  warnings: string[];
  truncated: boolean;
  charBudget: { used: number; max: number };
  generatedAt: string;
}

export interface RelatedEntityInfo {
  id: string;
  name: string;
  type: string;
  relation: string;
  confidence: number;
}

export interface TimelineEntryLite {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  source: string;
}

export interface DocumentRef {
  id: string;
  path: string;
  title: string;
  excerpt: string;
  score: number;
}

export type ResolveMethod = 'id' | 'alias' | 'name' | 'prefix' | 'search';

// Plan and execution types
export interface Plan {
  id: string;
  goalName: string;
  description: string;
  tasks: string[];
  estimatedEffort: number;
  potentialImpact: number;
  risk: number;
  steps: PlanStep[];
}

export interface PlanStep {
  id: string;
  description: string;
  toolId?: string;
  input?: Record<string, any>;
  requiresConfirmation?: boolean;
  dependencies?: string[];
}

export interface ConfirmationRequest {
  id: string;
  message: string;
  options: string[];
  timeoutMs?: number;
}

export interface BackgroundRun {
  id: string;
  taskId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  startTime: string;
  lastUpdate: string;
  result?: any;
  error?: string;
}

// Chat and response types
export type ManagerIntent = 
  | 'CHAT' 
  | 'GREETING' 
  | 'STOP' 
  | 'RESUME' 
  | 'MODE_SWITCH' 
  | 'IDEA' 
  | 'QUESTION' 
  | 'GOAL_CREATION' 
  | 'EXECUTION_CONFIRM' 
  | 'COMMAND';

export interface ChatResponse {
  type: 'conversation' | 'plan' | 'execution' | 'status';
  message: string;
  intent: ManagerIntent;
  requiresConfirmation: boolean;
  contextCards?: Array<{ label: string; value: string }>;
}

// Tool types
export type Permission = 'READ' | 'WRITE' | 'EXECUTE' | 'DELETE' | 'EXTERNAL' | 'NETWORK' | 'ADMIN';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SideEffect {
  type: 'DATA_CHANGE' | 'EXTERNAL_CALL' | 'FILE_SYSTEM' | 'NETWORK_REQUEST';
  description: string;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
}

export interface ToolResult<Output> {
  success: boolean;
  output: Output;
  error?: string;
  artifacts?: string[];
  metadata?: Record<string, any>;
}

// Event types for agent loop
export type AgentEventType = 
  | 'OBSERVE' 
  | 'UNDERSTAND' 
  | 'CONTEXT' 
  | 'REASON' 
  | 'PLAN' 
  | 'STEP_START' 
  | 'STEP_RESULT' 
  | 'RETRY' 
  | 'ADJUST' 
  | 'ASK_USER' 
  | 'COMPLETE' 
  | 'CANCELLED' 
  | 'PERSISTED';

export interface AgentEvent {
  type: AgentEventType;
  [key: string]: any;
}

// User input
export interface UserInput {
  text: string;
  timestamp: string;
  source: 'chat' | 'whatsapp' | 'mcp' | 'api';
  metadata?: Record<string, any>;
}

// Configuration
export interface BrainConfig {
  dbPath: string;
  groqKeys: string[];
  model: string;
  maxContextChars: number;
  defaultTemperature: number;
}