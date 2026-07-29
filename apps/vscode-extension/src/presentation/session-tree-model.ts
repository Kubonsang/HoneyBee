import type { AgentSession, SessionId } from "@honeybee/domain";

export interface SessionTreeNode {
  readonly session: AgentSession;
  readonly children: readonly SessionTreeNode[];
}

const sessionOrder = (left: AgentSession, right: AgentSession): number => {
  const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
  return updatedOrder === 0 ? left.title.localeCompare(right.title) : updatedOrder;
};

export const buildSessionTree = (sessions: readonly AgentSession[]): readonly SessionTreeNode[] => {
  const sessionsById = new Map<SessionId, AgentSession>(
    sessions.map((session) => [session.id, session]),
  );
  const childrenByParent = new Map<SessionId, AgentSession[]>();
  const roots: AgentSession[] = [];

  for (const session of sessions) {
    const parentId = session.parentSessionId;
    if (parentId === undefined || !sessionsById.has(parentId)) {
      roots.push(session);
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(session);
    childrenByParent.set(parentId, children);
  }

  const visited = new Set<SessionId>();
  const nodeFor = (session: AgentSession): SessionTreeNode => {
    if (visited.has(session.id)) {
      return { session, children: [] };
    }
    visited.add(session.id);
    const children = (childrenByParent.get(session.id) ?? []).sort(sessionOrder).map(nodeFor);
    return { session, children };
  };

  const result = roots.sort(sessionOrder).map(nodeFor);
  for (const session of [...sessions].sort(sessionOrder)) {
    if (!visited.has(session.id)) {
      result.push(nodeFor(session));
    }
  }
  return result;
};
