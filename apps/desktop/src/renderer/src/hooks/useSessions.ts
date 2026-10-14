import { applySessionEvent, type SessionState } from '@powerchord/core/sessions';
import { useEffect, useState } from 'react';
import type { SessionEventMessage, SessionSummary } from '../../../shared/ipc';

export function useSessionList(): SessionSummary[] {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.powerchord.onSessionsChanged(setSessions);
    void window.powerchord.listSessions().then((list) => {
      if (!cancelled) setSessions(list);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return sessions;
}

/**
 * Live state of one session: a snapshot from the main process, then incremental events.
 * Events are buffered until the snapshot arrives and skipped if the snapshot already has them.
 */
export function useSessionState(sessionId: string): SessionState | null {
  const [state, setState] = useState<{ id: string; value: SessionState } | null>(null);

  useEffect(() => {
    let snapshotSeq: number | null = null;
    let current: SessionState | null = null;
    const buffered: SessionEventMessage[] = [];

    const apply = (message: SessionEventMessage): void => {
      if (current === null || snapshotSeq === null || message.seq <= snapshotSeq) return;
      current = applySessionEvent(current, message.event);
      snapshotSeq = message.seq;
    };

    const unsubscribe = window.powerchord.onSessionEvent((message) => {
      if (message.sessionId !== sessionId) return;
      if (current === null) {
        buffered.push(message);
        return;
      }
      apply(message);
      setState({ id: sessionId, value: current });
    });

    void window.powerchord.getSession(sessionId).then((snapshot) => {
      if (!snapshot) return;
      current = snapshot.state;
      snapshotSeq = snapshot.seq;
      buffered.forEach(apply);
      setState({ id: sessionId, value: current });
    });

    return unsubscribe;
  }, [sessionId]);

  return state?.id === sessionId ? state.value : null;
}
