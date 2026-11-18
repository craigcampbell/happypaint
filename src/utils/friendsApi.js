const messages = {
  invalid_name: 'Choose a nickname of up to 24 characters without contact details or links.',
  invalid_code: 'Enter the 12-character friend code exactly as it was shared.',
  self_request: 'That is your own friend code. Enter the code from your friend.',
  contact_unavailable: 'That friend code is unavailable. Check it with the person who shared it.',
  incoming_request: 'This person already sent you a request. You can accept it below.',
  no_incoming_request: 'That request is no longer available. Refresh your list.',
  profile_required: 'Choose your nickname before adding a friend.',
  contact_limit: 'Your contact list is full.',
  rate_limited: 'Please wait a moment before trying again.',
  blocked: 'Friends is unavailable for this account.',
};

export async function friendsApi(token, path = '', { method = 'GET', body, signal } = {}) {
  const response = await fetch('/api/friends' + path, {
    method, signal, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(messages[data?.error] || 'Friends couldn’t connect. Try again in a moment.');
    error.status = response.status;
    throw error;
  }
  if (!data || !Object.hasOwn(data, 'self') || !['incoming', 'outgoing', 'friends'].every(key => Array.isArray(data[key]))) {
    throw new Error('Your friend list couldn’t load. Please try again.');
  }
  return data;
}
