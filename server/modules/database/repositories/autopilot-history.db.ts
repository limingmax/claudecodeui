import { getConnection } from '@/modules/database/connection.js';

export type AutopilotHistoryInsert = {
  sessionId: string;
  fromState: string;
  toState: string;
  event: string;
  reason?: string;
  counters?: Record<string, number>;
};

export type AutopilotHistoryRow = {
  id: number;
  sessionId: string;
  fromState: string;
  toState: string;
  event: string;
  reason: string | null;
  countersJson: string | null;
  createdAt: string;
};

type RawAutopilotHistoryRow = {
  id: number;
  session_id: string;
  from_state: string;
  to_state: string;
  event: string;
  reason: string | null;
  counters_json: string | null;
  created_at: string;
};

function mapRow(raw: RawAutopilotHistoryRow): AutopilotHistoryRow {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    fromState: raw.from_state,
    toState: raw.to_state,
    event: raw.event,
    reason: raw.reason,
    countersJson: raw.counters_json,
    createdAt: raw.created_at,
  };
}

export const autopilotHistoryDb = {
  insert(record: AutopilotHistoryInsert): number {
    const db = getConnection();
    const countersJson = record.counters != null ? JSON.stringify(record.counters) : null;
    const result = db
      .prepare(
        `INSERT INTO autopilot_history (session_id, from_state, to_state, event, reason, counters_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.sessionId,
        record.fromState,
        record.toState,
        record.event,
        record.reason ?? null,
        countersJson
      );
    return result.lastInsertRowid as number;
  },

  listBySession(sessionId: string, limit = 100): AutopilotHistoryRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT id, session_id, from_state, to_state, event, reason, counters_json, created_at
         FROM autopilot_history
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
      )
      .all(sessionId, limit) as RawAutopilotHistoryRow[];
    return rows.map(mapRow);
  },

  deleteBySession(sessionId: string): number {
    const db = getConnection();
    return db
      .prepare(`DELETE FROM autopilot_history WHERE session_id = ?`)
      .run(sessionId).changes;
  },
};
