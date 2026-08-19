import { describe, expect, it } from 'vitest';

import { AppUser, RingiRequest, RingiStatus, availableActions, isTerminal } from './models';

function user(role: AppUser['role'], uid = 'u-applicant'): AppUser {
  return { uid, employeeId: 'E0001', name: 'テスト太郎', role };
}

function request(status: RingiStatus, applicantId = 'u-applicant'): RingiRequest {
  return {
    id: 'r-1',
    title: 'テスト稟議',
    content: '内容',
    amount: 1000,
    applicantId,
    applicantName: 'テスト太郎',
    applicantEmployeeId: 'E0001',
    status,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('availableActions', () => {
  it('担当ステータスの承認者には承認・差し戻し・却下を提示する', () => {
    expect(availableActions(request('pending_system'), user('system_admin', 'u-sys'))).toEqual([
      'approve',
      'return',
      'reject',
    ]);
    expect(availableActions(request('pending_producer'), user('producer', 'u-pd'))).toEqual([
      'approve',
      'return',
      'reject',
    ]);
    expect(availableActions(request('pending_ceo'), user('ceo', 'u-ceo'))).toEqual([
      'approve',
      'return',
      'reject',
    ]);
  });

  it('担当外のステータスでは操作を提示しない', () => {
    expect(availableActions(request('pending_producer'), user('system_admin', 'u-sys'))).toEqual([]);
    expect(availableActions(request('pending_system'), user('ceo', 'u-ceo'))).toEqual([]);
  });

  it('申請者ロールは他者の稟議に対して操作できない', () => {
    expect(availableActions(request('pending_system'), user('applicant', 'u-other'))).toEqual([]);
  });

  it('差し戻しの再申請は申請者本人にのみ提示する', () => {
    expect(availableActions(request('returned'), user('applicant', 'u-applicant'))).toEqual([
      'resubmit',
    ]);
    expect(availableActions(request('returned'), user('applicant', 'u-other'))).toEqual([]);
    // 承認者であっても申請者本人でなければ再申請はできない
    expect(availableActions(request('returned'), user('system_admin', 'u-sys'))).toEqual([]);
  });

  it('終端ステータスではいかなる操作も提示しない', () => {
    for (const status of ['approved', 'rejected'] as const) {
      expect(availableActions(request(status), user('system_admin', 'u-sys'))).toEqual([]);
      expect(availableActions(request(status), user('ceo', 'u-ceo'))).toEqual([]);
      expect(availableActions(request(status), user('applicant', 'u-applicant'))).toEqual([]);
    }
  });
});

describe('isTerminal', () => {
  it('approved と rejected のみ終端とする', () => {
    expect(isTerminal('approved')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('returned')).toBe(false);
    expect(isTerminal('pending_system')).toBe(false);
    expect(isTerminal('pending_producer')).toBe(false);
    expect(isTerminal('pending_ceo')).toBe(false);
  });
});
