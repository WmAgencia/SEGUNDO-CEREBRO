/**
 * Context Compiler - Unified context building for the simplified Second Brain agent
 * Combines functionality from context-builder.ts and manager's buildSystemContext
 */

import { DatabaseSync } from "node:sqlite";
import { CompiledContext, RelatedEntityInfo, TimelineEntryLite, DocumentRef, ResolveMethod } from "./types";

// Mock implementations - will be replaced with actual database queries
export async function compileContext(
  input: { 
    subject: string; 
    task?: string; 
    depth?: number; 
    maxChars?: number;
  },
  dbPath: string
): Promise<CompiledContext> {
  const db = new DatabaseSync(dbPath);
  
  try {
    // Default values
    const maxChars = input.maxChars || 12000;
    const depth = input.depth || 2;
    
    // 1. Resolve entity (if any)
    const entityId = await resolveEntity(input.subject, db);
    const resolvedBy = entityId ? 'search' : null;
    
    // 2. Build context components
    const memories = await getRelevantMemories(input.subject, db);
    const recentEvents = await getRecentEvents(db, 12);
    const documents = await searchDocuments(input.subject, input.task, db);
    const relatedEntities = await getRelatedEntities(input.subject, db, depth);
    const decisions = await getDecisions(input.subject, db);
    const procedures = await getProcedures(input.subject, db);
    
    // 3. Generate summary
    const summary = generateSummary({
      memories,
      recentEvents,
      documents,
      relatedEntities,
      decisions,
      procedures
    });
    
    // 4. Calculate character budget
    const contextSize = calculateContextSize({
      memories,
      recentEvents,
      documents,
      relatedEntities,
      decisions,
      procedures,
      summary
    });
    
    // 5. Truncate if necessary
    const truncated = contextSize.used > maxChars;
    
    return {
      subject: input.subject,
      entityId,
      resolvedBy,
      entityType: entityId ? await getEntityType(entityId, db) : null,
      status: entityId ? await getEntityStatus(entityId, db) : null,
      summary,
      aliases: [],
      relatedEntities,
      decisions,
      procedures,
      recentEvents,
      documents,
      sources: [
        { sourceType: 'database', location: dbPath },
        { sourceType: 'memories', location: 'working_memory' }
      ],
      warnings: [],
      truncated,
      charBudget: {
        used: contextSize.used,
        max: maxChars
      },
      generatedAt: new Date().toISOString()
    };
  } finally {
    db.close();
  }
}

// Helper functions (mock implementations - will connect to actual DB later)
async function resolveEntity(subject: string, db: DatabaseSync): Promise<string | null> {
  // In real implementation: search entities by name, alias, id
  // For now, return null for simplicity
  return null;
}

async function getRelevantMemories(subject: string, db: DatabaseSync): Promise<string[]> {
  // In real implementation: query memories table with FTS5
  return [`Memory about ${subject} from yesterday`, `Previous conversation about ${subject}`];
}

async function getRecentEvents(db: DatabaseSync, limit: number): Promise<TimelineEntryLite[]> {
  // In real implementation: query events table ordered by timestamp
  return [
    { id: 'evt1', type: 'message', title: 'User message', description: 'Hello', timestamp: new Date().toISOString(), source: 'chat' },
    { id: 'evt2', type: 'decision', title: 'Goal created', description: 'New goal for project X', timestamp: new Date(Date.now() - 3600000).toISOString(), source: 'brain' }
  ];
}

async function searchDocuments(subject: string, task: string | undefined, db: DatabaseSync): Promise<DocumentRef[]> {
  // In real implementation: search documents with BM25 + metadata filters
  return [
    { id: 'doc1', path: 'projects/x.md', title: 'Project X Overview', excerpt: 'Overview of project X goals and timeline', score: 0.85 },
    { id: 'doc2', path: 'goals/q3.md', title: 'Q3 Goals', excerpt: 'Quarterly goals including project X', score: 0.72 }
  ];
}

async function getRelatedEntities(subject: string, db: DatabaseSync, depth: number): Promise<RelatedEntityInfo[]> {
  // In real implementation: graph traversal in relations table
  return [
    { id: 'proj-x', name: 'Project X', type: 'project', relation: 'related_to', confidence: 0.9 },
    { id: 'goal-q3', name: 'Q3 Goal', type: 'goal', relation: 'contains', confidence: 0.8 }
  ];
}

async function getDecisions(subject: string, db: DatabaseSync): Promise<Array<{ id: string; title: string; status: string | null }>> {
  // In real implementation: query decisions table
  return [
    { id: 'dec1', title: 'Approve Project X', status: 'APPROVED' },
    { id: 'dec2', title: 'Budget Allocation', status: 'PENDING' }
  ];
}

async function getProcedures(subject: string, db: DatabaseSync): Promise<Array<{ id: string; title: string; status: string | null }>> {
  // In real implementation: query procedures table
  return [
    { id: 'proc1', title: 'Project Setup', status: 'ACTIVE' },
    { id: 'proc2', title: 'Client Onboarding', status: 'COMPLETED' }
  ];
}

async function getEntityType(entityId: string, db: DatabaseSync): Promise<string | null> {
  // In real implementation: query entities table
  return 'project';
}

async function getEntityStatus(entityId: string, db: DatabaseSync): Promise<string | null> {
  // In real implementation: query entities table
  return 'ACTIVE';
}

function generateSummary(params: {
  memories: string[];
  recentEvents: TimelineEntryLite[];
  documents: DocumentRef[];
  relatedEntities: RelatedEntityInfo[];
  decisions: Array<{ id: string; title: string; status: string | null }>;
  procedures: Array<{ id: string; title: string; status: string | null }>;
}): string {
  const parts = [];
  
  if (params.memories.length > 0) {
    parts.push(`Memories: ${params.memories.slice(0, 2).join(', ')}`);
  }
  
  if (params.recentEvents.length > 0) {
    parts.push(`Recent events: ${params.recentEvents.slice(0, 2).map(e => e.title).join(', ')}`);
  }
  
  if (params.documents.length > 0) {
    parts.push(`Relevant documents: ${params.documents.slice(0, 2).map(d => d.title).join(', ')}`);
  }
  
  if (params.relatedEntities.length > 0) {
    parts.push(`Related entities: ${params.relatedEntities.slice(0, 2).map(e => e.name).join(', ')}`);
  }
  
  return parts.join('; ');
}

function calculateContextSize(params: {
  memories: string[];
  recentEvents: TimelineEntryLite[];
  documents: DocumentRef[];
  relatedEntities: RelatedEntityInfo[];
  decisions: Array<{ id: string; title: string; status: string | null }>;
  procedures: Array<{ id: string; title: string; status: string | null }>;
  summary: string;
}): { used: number } {
  let total = 0;
  
  total += params.summary.length;
  total += params.memories.reduce((sum, m) => sum + m.length, 0);
  total += params.recentEvents.reduce((sum, e) => sum + e.title.length + e.description.length, 0);
  total += params.documents.reduce((sum, d) => sum + d.title.length + d.excerpt.length, 0);
  total += params.relatedEntities.reduce((sum, e) => sum + e.name.length + e.type.length, 0);
  total += params.decisions.reduce((sum, d) => sum + d.title.length, 0);
  total += params.procedures.reduce((sum, p) => sum + p.title.length, 0);
  
  return { used: total };
}