export const SCHEMA_VERSION = 5;

export interface Migration {
  from: number;
  statements: readonly string[];
}

const PHASE19_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS teams (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    manager_agent TEXT,
    members       TEXT NOT NULL DEFAULT '[]',
    capabilities  TEXT NOT NULL DEFAULT '[]',
    projects      TEXT NOT NULL DEFAULT '[]',
    metadata      TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS task_assignments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        INTEGER NOT NULL REFERENCES initiative_tasks(id),
    initiative_id  TEXT NOT NULL REFERENCES initiatives(id),
    assigned_agent TEXT NOT NULL REFERENCES agents(id),
    reason         TEXT NOT NULL DEFAULT '',
    priority       REAL NOT NULL DEFAULT 50,
    status         TEXT NOT NULL DEFAULT 'ACTIVE',
    assigned_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS work_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT NOT NULL REFERENCES agents(id),
    task_id       INTEGER NOT NULL REFERENCES initiative_tasks(id),
    initiative_id TEXT NOT NULL,
    started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ended_at      TEXT,
    status        TEXT NOT NULL DEFAULT 'RUNNING',
    inputs        TEXT NOT NULL DEFAULT '{}',
    outputs       TEXT NOT NULL DEFAULT '{}',
    errors        TEXT NOT NULL DEFAULT '[]',
    metrics       TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS handoffs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent    TEXT NOT NULL,
    to_agent      TEXT NOT NULL,
    task_id       INTEGER REFERENCES initiative_tasks(id),
    initiative_id TEXT,
    summary       TEXT NOT NULL DEFAULT '',
    payload       TEXT NOT NULL DEFAULT '{}',
    sources       TEXT NOT NULL DEFAULT '[]',
    confidence    REAL NOT NULL DEFAULT 0.8,
    status        TEXT NOT NULL DEFAULT 'CREATED',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent    TEXT NOT NULL,
    to_agent      TEXT NOT NULL,
    type          TEXT NOT NULL,
    subject       TEXT NOT NULL DEFAULT '',
    context_data  TEXT NOT NULL DEFAULT '{}',
    message       TEXT NOT NULL DEFAULT '',
    attachments   TEXT NOT NULL DEFAULT '[]',
    task_id       INTEGER,
    initiative_id TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER REFERENCES initiative_tasks(id),
    initiative_id TEXT,
    agent_id      TEXT,
    type          TEXT NOT NULL DEFAULT 'OTHER',
    payload       TEXT NOT NULL DEFAULT '{}',
    reason        TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'PENDING',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved_at   TEXT,
    resolved_by   TEXT,
    decision      TEXT,
    feedback      TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agent_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        INTEGER NOT NULL REFERENCES initiative_tasks(id),
    session_id     INTEGER,
    agent_id       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'VALID',
    summary        TEXT NOT NULL DEFAULT '',
    output         TEXT NOT NULL DEFAULT '',
    artifacts      TEXT NOT NULL DEFAULT '[]',
    sources        TEXT NOT NULL DEFAULT '[]',
    confidence     REAL NOT NULL DEFAULT 0.8,
    metrics        TEXT NOT NULL DEFAULT '{}',
    next_recommended_action TEXT,
    review_status  TEXT NOT NULL DEFAULT 'PENDING',
    review_feedback TEXT,
    rework_of      INTEGER REFERENCES agent_results(id),
    rework_count   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
];

const PHASE19_MIGRATIONS: readonly string[] = [
  "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'specialist'",
  "ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN projects TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN goals TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN workload INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agents ADD COLUMN capacity INTEGER NOT NULL DEFAULT 3",
  "ALTER TABLE agents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
  ...PHASE19_DDL,
];

const PHASE18_DDL: readonly string[] = [
   `CREATE TABLE IF NOT EXISTS goals (
     id             TEXT PRIMARY KEY,
     name           TEXT NOT NULL,
     description    TEXT NOT NULL DEFAULT '',
     type           TEXT NOT NULL DEFAULT 'PROJECT',
     status         TEXT NOT NULL DEFAULT 'DRAFT',
     priority       INTEGER NOT NULL DEFAULT 3,
     owner_agent    TEXT,
     parent_goal_id TEXT REFERENCES goals(id),
     project        TEXT,
     metric_name    TEXT,
     target         REAL,
     current_value  REAL,
     deadline       TEXT,
     constraints_json TEXT NOT NULL DEFAULT '[]',
     created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
   "CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)",
   `CREATE TABLE IF NOT EXISTS goal_observations (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     obs_type    TEXT NOT NULL,
     source      TEXT NOT NULL DEFAULT 'system',
     project     TEXT,
     entity_id   TEXT,
     data        TEXT NOT NULL DEFAULT '{}',
     confidence  REAL NOT NULL DEFAULT 0.7,
     importance  REAL NOT NULL DEFAULT 0.5,
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
   "CREATE INDEX IF NOT EXISTS idx_goal_obs_type ON goal_observations(obs_type)",
   `CREATE TABLE IF NOT EXISTS opportunities (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     title            TEXT NOT NULL,
     description      TEXT NOT NULL DEFAULT '',
     source_observation INTEGER REFERENCES goal_observations(id),
     goal_id          TEXT REFERENCES goals(id),
     project          TEXT,
     potential_impact REAL,
     estimated_effort REAL,
     risk             REAL,
     confidence       REAL NOT NULL DEFAULT 0.6,
     status           TEXT NOT NULL DEFAULT 'NEW',
     created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
   `CREATE TABLE IF NOT EXISTS hypotheses (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     opportunity_id    INTEGER REFERENCES opportunities(id),
     statement         TEXT NOT NULL,
     evidence_json     TEXT NOT NULL DEFAULT '[]',
     confidence        REAL NOT NULL DEFAULT 0.6,
     expected_outcome  TEXT,
     metric_name       TEXT,
     validation_method TEXT
   )`,
   `CREATE TABLE IF NOT EXISTS initiatives (
     id               TEXT PRIMARY KEY,
     title            TEXT NOT NULL,
     description      TEXT NOT NULL DEFAULT '',
     goal_id          TEXT REFERENCES goals(id),
     project          TEXT,
     hypothesis_id    INTEGER REFERENCES hypotheses(id),
     owner_agent      TEXT,
     support_agents   TEXT NOT NULL DEFAULT '[]',
     required_skills  TEXT NOT NULL DEFAULT '[]',
     required_tools   TEXT NOT NULL DEFAULT '[]',
     estimated_cost   REAL,
     effort           REAL,
     impact           REAL,
     probability      REAL,
     risk             REAL,
     expected_outcome TEXT,
     status           TEXT NOT NULL DEFAULT 'DRAFT',
     approval_status  TEXT NOT NULL DEFAULT 'PENDING',
     approved_by      TEXT,
     approved_at      TEXT,
     rejection_reason TEXT,
     created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
   "CREATE INDEX IF NOT EXISTS idx_initiatives_status ON initiatives(status)",
   `CREATE TABLE IF NOT EXISTS initiative_tasks (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     initiative_id TEXT NOT NULL REFERENCES initiatives(id),
     ordinal       INTEGER NOT NULL,
     title         TEXT NOT NULL,
     depends_on    INTEGER,
     assigned_agent TEXT,
     required_tools TEXT NOT NULL DEFAULT '[]',
     priority      REAL,
     updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     status        TEXT NOT NULL DEFAULT 'PENDING'
   )`,
   "CREATE INDEX IF NOT EXISTS idx_init_tasks ON initiative_tasks(initiative_id)",
];

export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    statements: [
      "ALTER TABLE entities ADD COLUMN origin_document_id TEXT REFERENCES documents(id)",
      "ALTER TABLE relations ADD COLUMN origin_document_id TEXT REFERENCES documents(id)",
    ],
  },
  {
    from: 2,
    statements: [
      "ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5",
      "ALTER TABLE memories ADD COLUMN project TEXT",
      "ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE memories ADD COLUMN last_accessed_at TEXT",
      "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, content, category)",
      `CREATE TABLE IF NOT EXISTS working_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_wm_task ON working_memory(task_key)",
    ],
  },
  {
    from: 3,
    statements: PHASE18_DDL,
  },
  {
    from: 4,
    statements: PHASE19_MIGRATIONS,
  },
];

export const SCHEMA_STATEMENTS: readonly string[] = [
  ...PHASE18_DDL,
  ...PHASE19_DDL,
  `CREATE TABLE IF NOT EXISTS index_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sources (
    id          TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    location    TEXT,
    external_id TEXT,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS documents (
    id             TEXT PRIMARY KEY,
    path           TEXT NOT NULL UNIQUE,
    title          TEXT,
    type           TEXT,
    hash           TEXT NOT NULL,
    created_at     TEXT,
    modified_at    TEXT,
    indexed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    content_length INTEGER NOT NULL DEFAULT 0,
    metadata       TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)`,

  `CREATE TABLE IF NOT EXISTS entities (
    id                 TEXT PRIMARY KEY,
    canonical_name     TEXT NOT NULL,
    type               TEXT NOT NULL,
    status             TEXT,
    aliases            TEXT NOT NULL DEFAULT '[]',
    metadata           TEXT NOT NULL DEFAULT '{}',
    source_id          TEXT REFERENCES sources(id),
    origin_document_id TEXT REFERENCES documents(id),
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name)`,

  `CREATE TABLE IF NOT EXISTS relations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_entity      TEXT NOT NULL REFERENCES entities(id),
    relation_type      TEXT NOT NULL,
    target_entity      TEXT NOT NULL REFERENCES entities(id),
    confidence         REAL NOT NULL DEFAULT 1.0,
    valid_from         TEXT,
    valid_until        TEXT,
    source_id          TEXT REFERENCES sources(id),
    origin_document_id TEXT REFERENCES documents(id),
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity)`,
  `CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity)`,

  `CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    subject     TEXT,
    payload     TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject)`,

  `CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_kind TEXT NOT NULL,
    category    TEXT,
    content     TEXT NOT NULL,
    entity_id   TEXT REFERENCES entities(id),
    confidence  REAL NOT NULL DEFAULT 0.8,
    source_id   TEXT REFERENCES sources(id),
    importance  REAL NOT NULL DEFAULT 0.5,
    project     TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    metadata    TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(memory_kind)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    memory_id UNINDEXED,
    content,
    category
  )`,

  `CREATE TABLE IF NOT EXISTS working_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wm_task ON working_memory(task_key)`,

  `CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    heading     TEXT,
    content     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    doc_id UNINDEXED,
    title,
    body,
    tags,
    aliases,
    headings
  )`,

  `CREATE TABLE IF NOT EXISTS agents (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    role         TEXT NOT NULL DEFAULT 'specialist',
    domains      TEXT NOT NULL DEFAULT '[]',
    capabilities TEXT NOT NULL DEFAULT '[]',
    skills       TEXT NOT NULL DEFAULT '[]',
    tools        TEXT NOT NULL DEFAULT '[]',
    projects     TEXT NOT NULL DEFAULT '[]',
    goals        TEXT NOT NULL DEFAULT '[]',
    permissions  TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL DEFAULT 'active',
    workload     INTEGER NOT NULL DEFAULT 0,
    capacity     INTEGER NOT NULL DEFAULT 3,
    metadata     TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS tools_registry (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    description TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'general',
    permissions TEXT NOT NULL DEFAULT '["READ"]',
    origin      TEXT NOT NULL DEFAULT 'local',
    available   INTEGER NOT NULL DEFAULT 1,
    metadata    TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'skill',
    source      TEXT NOT NULL DEFAULT '',
    repo        TEXT,
    path        TEXT,
    hash        TEXT,
    version     TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    metadata    TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS skill_sources (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'external',
    url             TEXT,
    last_indexed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS skill_relations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id      TEXT NOT NULL REFERENCES skills(id),
    relation_type TEXT NOT NULL,
    target        TEXT NOT NULL,
    UNIQUE(skill_id, relation_type, target)
  )`,

  `CREATE TABLE IF NOT EXISTS observations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_key      TEXT NOT NULL,
    observation_type TEXT NOT NULL,
    subject          TEXT,
    payload          TEXT NOT NULL DEFAULT '{}',
    count            INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'observation',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(pattern_key, observation_type)
  )`,

  `CREATE TABLE IF NOT EXISTS research_questions (
    id         TEXT PRIMARY KEY,
    question   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS research_claims (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id   TEXT NOT NULL REFERENCES research_questions(id),
    claim         TEXT NOT NULL,
    normalized    TEXT NOT NULL,
    source        TEXT,
    authority     REAL NOT NULL DEFAULT 0.5,
    source_date   TEXT,
    confidence    REAL NOT NULL DEFAULT 0.6,
    status        TEXT NOT NULL DEFAULT 'NEW',
    related_entity TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
];
