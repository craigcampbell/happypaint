import assert from 'node:assert/strict';
import test from 'node:test';
import { adminRoomCode } from '../src/utils/adminRoomCode.js';

test('admin watch preserves exact valid identifiers instead of visiting a different room', () => {
  for (const code of ['MAIN', 'QA_ROOM-1', 'ABCDEFGHIJKLMNOP']) assert.equal(adminRoomCode(code), code);
  for (const code of ['', 'main', 'QA/ROOM', 'QA ROOM', 'ABCDEFGHIJKLMNOPQ', null, undefined]) assert.equal(adminRoomCode(code), '');
});
