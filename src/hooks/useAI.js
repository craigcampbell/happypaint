import { useCallback } from 'react';

const API_URL = import.meta.env.VITE_SERVER_URL || '';

export const useAI = () => {
  const chat = useCallback(async (messages) => {
    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      return data.reply || 'I\'m here to help with your art!';
    } catch (err) {
      console.error('AI chat error:', err);
      return "I'm currently unavailable. Please try again later or check the AI configuration.";
    }
  }, []);

  return { chat };
};
