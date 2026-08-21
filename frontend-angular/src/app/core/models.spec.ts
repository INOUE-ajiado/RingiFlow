import { describe, expect, it } from 'vitest';

import {
  AppUser,
  FIELD_LABELS,
  RingiRequest,
  RingiStatus,
  approvalRoute,
  availableActions,
  canModifyAttachments,
  formatFieldValue,
  formatFileSize,
  isTerminal,
  requiresCEOApproval,
} from './models';

function user(role: AppUser['role'], uid = 'u-applicant'): AppUser {
  return { uid, employeeId: 'E0001', name: 'テスト太郎', role, department: '企画事業部' };
}

function request(status: RingiStatus, applicantId = 'u-applicant'): RingiRequest {
  return {
    id: 'r-1',
    requestNo: 'R-2026-0001',
    title: 'テスト稟議',
    content: '内容',
    amount: 1000,
    applicantId,
    applicantName: 'テスト太郎',
    applicantEmployeeId: 'E0001',
    status,
    department: '企画事業部',
    dueDate: null,
    summary: null,
    attachments: null,
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
      'withdraw',
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

describe('マスターロール', () => {
  it('各承認待ちステータスで全操作を提示する', () => {
    const master = user('master', 'uid-master');
    for (const status of ['pending_system', 'pending_producer', 'pending_ceo'] as const) {
      expect(availableActions(request(status), master)).toEqual([
        'approve',
        'return',
        'reject',
        'withdraw',
      ]);
    }
  });

  it('他者が申請した差し戻し稟議でも再申請を提示する', () => {
    const master = user('master', 'uid-master');
    expect(availableActions(request('returned', 'uid-someone-else'), master)).toEqual([
      'resubmit',
      'withdraw',
    ]);
  });

  // 状態遷移表そのものは迂回しない
  it('終端ステータスでは操作を提示しない', () => {
    const master = user('master', 'uid-master');
    expect(availableActions(request('approved'), master)).toEqual([]);
    expect(availableActions(request('rejected'), master)).toEqual([]);
  });
});

describe('取り下げ', () => {
  it('決裁確定前は申請者本人に取り下げを提示する', () => {
    const owner = user('applicant', 'u-applicant');
    for (const status of ['pending_system', 'pending_producer', 'pending_ceo'] as const) {
      expect(availableActions(request(status), owner)).toContain('withdraw');
    }
    expect(availableActions(request('returned'), owner)).toEqual(['resubmit', 'withdraw']);
  });

  it('他人には取り下げを提示しない', () => {
    const other = user('applicant', 'uid-other');
    expect(availableActions(request('pending_system'), other)).toEqual([]);
    // 承認者は自身の承認操作のみで、取り下げは含まれない
    expect(availableActions(request('pending_system'), user('system_admin', 'uid-sys'))).toEqual([
      'approve',
      'return',
      'reject',
    ]);
  });

  it('取り下げ済みは終端として扱う', () => {
    expect(isTerminal('withdrawn')).toBe(true);
    const owner = user('applicant', 'u-applicant');
    expect(availableActions(request('withdrawn'), owner)).toEqual([]);
    expect(availableActions(request('withdrawn'), user('master', 'uid-master'))).toEqual([]);
  });
});

describe('添付ファイル', () => {
  it('申請者本人は決裁確定前に変更できる', () => {
    const owner = user('applicant', 'u-applicant');
    for (const status of ['pending_system', 'pending_producer', 'pending_ceo', 'returned'] as const) {
      expect(canModifyAttachments(request(status), owner)).toBe(true);
    }
  });

  it('決裁確定後は誰も変更できない', () => {
    for (const status of ['approved', 'rejected', 'withdrawn'] as const) {
      expect(canModifyAttachments(request(status), user('applicant', 'u-applicant'))).toBe(false);
      expect(canModifyAttachments(request(status), user('master', 'uid-master'))).toBe(false);
    }
  });

  it('他人は変更できない', () => {
    expect(canModifyAttachments(request('pending_system'), user('applicant', 'u-other'))).toBe(false);
    expect(canModifyAttachments(request('pending_system'), user('ceo', 'u-ceo'))).toBe(false);
  });

  it('マスターは決裁確定前なら変更できる', () => {
    expect(canModifyAttachments(request('pending_ceo'), user('master', 'uid-master'))).toBe(true);
  });
});

describe('formatFileSize', () => {
  it('単位を切り替えて表示する', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10.0 MB');
  });
});

describe('金額による承認ルート', () => {
  const THRESHOLD = 100000;

  it('閾値未満はプロデューサーまでの2段階', () => {
    const route = approvalRoute(THRESHOLD - 1, THRESHOLD);
    expect(route.map((s) => s.status)).toEqual(['pending_system', 'pending_producer']);
  });

  it('閾値以上は代表までの3段階', () => {
    const route = approvalRoute(THRESHOLD, THRESHOLD);
    expect(route.map((s) => s.status)).toEqual([
      'pending_system',
      'pending_producer',
      'pending_ceo',
    ]);
  });

  it('境界値を正しく扱う', () => {
    expect(requiresCEOApproval(THRESHOLD - 1, THRESHOLD)).toBe(false);
    expect(requiresCEOApproval(THRESHOLD, THRESHOLD)).toBe(true);
    expect(requiresCEOApproval(THRESHOLD + 1, THRESHOLD)).toBe(true);
    expect(requiresCEOApproval(0, THRESHOLD)).toBe(false);
  });

  it('どのルートもシステム担当から始まる', () => {
    for (const amount of [0, 50000, THRESHOLD, 1000000]) {
      expect(approvalRoute(amount, THRESHOLD)[0].status).toBe('pending_system');
    }
  });
});

describe('変更差分の表示', () => {
  it('項目名を日本語に解決する', () => {
    expect(FIELD_LABELS['title']).toBe('件名');
    expect(FIELD_LABELS['content']).toBe('申請理由・目的');
    expect(FIELD_LABELS['amount']).toBe('金額');
    expect(FIELD_LABELS['dueDate']).toBe('決裁希望日');
    expect(FIELD_LABELS['summary']).toBe('概要');
  });

  it('金額は3桁区切りに整形する', () => {
    expect(formatFieldValue('amount', '250000')).toBe('250,000円');
    expect(formatFieldValue('amount', '0')).toBe('0円');
  });

  it('金額以外はそのまま返す', () => {
    expect(formatFieldValue('title', '開発用PCの購入')).toBe('開発用PCの購入');
    expect(formatFieldValue('content', '理由は以下のとおり')).toBe('理由は以下のとおり');
  });

  it('数値として解釈できない金額はそのまま返す', () => {
    expect(formatFieldValue('amount', 'not-a-number')).toBe('not-a-number');
  });
});
