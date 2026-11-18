import { useEffect, useState } from 'react';
import { getSession, hasStoredSession, isCloudConfigured, onAuthStateChange } from '../utils/auth';
import { fetchDrawingPrompts } from '../utils/drawingPrompts';

export default function useHomeDrawingPrompts() {
  const [feed, setFeed] = useState(() => ({
    status: isCloudConfigured && !hasStoredSession() ? 'guest' : 'loading', ideas: [],
  }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let controller;
    let sessionChanged = false;
    const load = async (session) => {
      if (!active) return;
      controller?.abort();
      const token = session?.access_token;
      if (isCloudConfigured && !token) {
        setFeed({ status: 'guest', ideas: [] });
        return;
      }
      controller = new AbortController();
      const { signal } = controller;
      setFeed({ status: 'loading', ideas: [] });
      try {
        const catalogue = await fetchDrawingPrompts(token, signal);
        const ideas = catalogue.filter((item) => item.id.startsWith('idea-'));
        if (!ideas.length) throw new Error('Empty idea list');
        if (!signal.aborted) setFeed({ status: 'ready', ideas });
      } catch (error) {
        if (!signal.aborted) setFeed({ status: error.status === 401 ? 'rejected' : 'error', ideas: [] });
      }
    };
    const unsubscribe = onAuthStateChange((session) => {
      sessionChanged = true;
      load(session);
    });
    getSession().then((session) => { if (!sessionChanged) load(session); });
    return () => { active = false; controller?.abort(); unsubscribe(); };
  }, [attempt]);

  return { ...feed, retry: () => setAttempt((n) => n + 1) };
}
