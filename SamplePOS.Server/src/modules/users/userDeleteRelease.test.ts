import { describe, expect, it } from '@jest/globals';
import { SYSTEM_USER_ID as CONSTANTS_SYSTEM_USER_ID } from '../../utils/constants.js';
import {
  SYSTEM_USER_ID,
  USER_DELETE_IDENTITY_TABLES,
  userFkReleaseAction,
} from './userRepository.js';

describe('permanent user delete release', () => {
  it('uses constants SYSTEM_USER_ID — no local UUID mismatch', () => {
    expect(SYSTEM_USER_ID).toBe(CONSTANTS_SYSTEM_USER_ID);
    expect(SYSTEM_USER_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('lets the database cascade or null a foreign key it already handles', () => {
    expect(userFkReleaseAction('audit_log', true, 'c')).toBe('skip');
    expect(userFkReleaseAction('employees', false, 'n')).toBe('skip');
  });

  it('removes login-only rows', () => {
    for (const table of USER_DELETE_IDENTITY_TABLES) {
      expect(userFkReleaseAction(table, true, 'a')).toBe('delete-rows');
    }
  });

  it('clears optional actor columns and keeps required history', () => {
    expect(userFkReleaseAction('employees', false, 'a')).toBe('set-null');
    expect(userFkReleaseAction('audit_log', true, 'r')).toBe('reassign');
    expect(userFkReleaseAction('treasury_documents', true, 'a')).toBe('reassign');
    expect(userFkReleaseAction('sales', true, 'a')).toBe('reassign');
  });
});
