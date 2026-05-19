import './ChatPanel.css';

const ChatPanel = ({ messages, onSend, input, onInputChange, onAIChat }) => {
  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Chat</span>
      </div>
      <div className="chat-messages">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-message ${msg.isAI ? 'ai-message' : ''} ${msg.isUser ? 'user-message' : ''}`}
          >
            <div className="chat-msg-header">
              <span
                className="chat-user-dot"
                style={{ backgroundColor: msg.color }}
              />
              <span className="chat-user-name">{msg.user}</span>
            </div>
            <div className="chat-msg-text">{msg.message}</div>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSend()}
          placeholder="Type a message..."
          className="chat-input"
        />
        <button className="chat-send" onClick={onSend}>
          Send
        </button>
      </div>
      <div className="chat-ai-row">
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAIChat()}
          placeholder="Ask AI about art..."
          className="chat-input ai-input"
        />
        <button className="chat-ai-send" onClick={onAIChat}>
          🎨
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;
