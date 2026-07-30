export default function QuestPanel({ quest, onNominate }) {
  if (!quest?.missions?.length) return null;
  const completed = new Set(quest.completedIds || []);
  return (
    <aside className="quest-panel" aria-label="Canvas quests">
      <div className="quest-panel-head">
        <strong>🧭 Canvas Quests</strong>
        <span>{completed.size}/{quest.missions.length}</span>
      </div>
      <ul>
        {quest.missions.map((mission) => {
          const done = completed.has(mission.id);
          const votes = quest.counts?.[mission.id] || 0;
          const needed = quest.needed || 1;
          return (
            <li key={mission.id} className={done ? "is-done" : ""}>
              <span className="quest-emoji" aria-hidden="true">{mission.emoji}</span>
              <span className="quest-copy">
                <span>{mission.text}</span>
                {!done && votes > 0 ? <small>{votes}/{needed} artists agree</small> : null}
              </span>
              <button
                type="button"
                onClick={() => onNominate(mission.id)}
                disabled={done}
                aria-label={done ? `${mission.text} completed` : `Mark ${mission.text} complete`}
              >
                {done ? "✓" : "Done?"}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
