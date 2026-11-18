import { useEffect, useState } from 'react';
import { getCuratorDefaults, validateCuratorContent } from '../data/curatorContent';

// Only the public publication endpoint. Never read the admin document here.
export default function useCuratorContent(page) {
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/curator/pages', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const data = await response.json();
        const result = validateCuratorContent(page, data?.pages?.[page]);
        if (!controller.signal.aborted) setLoaded({ page, content: result.ok ? result.content : getCuratorDefaults(page) });
      }).catch(() => {
        if (!controller.signal.aborted) setLoaded({ page, content: getCuratorDefaults(page) });
      });
    return () => controller.abort();
  }, [page]);
  return loaded?.page === page ? loaded.content : getCuratorDefaults(page);
}
