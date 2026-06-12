import './UserList.css';

const UserList = ({ users }) => {
  if (!users || users.length === 0) {
    return (
      <div className="user-list">
        <div className="user-list-header">
          <span>👥 Artists</span>
        </div>
        <div className="user-list-empty">No users yet</div>
      </div>
    );
  }

  return (
    <div className="user-list">
      <div className="user-list-header">
        <span>👥 Artists ({users.length})</span>
      </div>
      <div className="user-list-items">
        {users.map((user) => (
          <div key={user.id} className="user-item">
            <div
              className="user-avatar"
              style={{ backgroundColor: user.color }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            <span className="user-name">{user.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default UserList;
