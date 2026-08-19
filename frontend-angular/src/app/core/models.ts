/**
 * ドメインモデルと状態遷移の定義。
 *
 * TRANSITIONS は基本設計書 3.3節の状態遷移表をクライアント側に写したものであり、
 * 操作ボタンの表示判定にのみ用いる。遷移の可否を最終的に決定するのは常に
 * Go バックエンドAPI であり、ここでの判定はUI上の利便性のためのものである。
 */

export type RingiStatus =
  | 'pending_system'
  | 'pending_producer'
  | 'pending_ceo'
  | 'approved'
  | 'rejected'
  | 'returned';

export type Role = 'applicant' | 'system_admin' | 'producer' | 'ceo';

export type RingiAction = 'approve' | 'return' | 'reject' | 'resubmit';

export interface AppUser {
  uid: string;
  employeeId: string;
  name: string;
  role: Role;
}

export interface RingiRequest {
  id: string;
  title: string;
  content: string;
  amount: number;
  applicantId: string;
  applicantName: string;
  applicantEmployeeId: string;
  status: RingiStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  requestId: string;
  action: RingiAction | 'create';
  actorId: string;
  actorName: string;
  comment: string;
  timestamp: string;
}

export const STATUS_LABELS: Record<RingiStatus, string> = {
  pending_system: 'システム担当承認待ち',
  pending_producer: 'プロデューサー承認待ち',
  pending_ceo: '代表承認待ち',
  approved: '決裁完了',
  rejected: '却下',
  returned: '差し戻し',
};

export const ROLE_LABELS: Record<Role, string> = {
  applicant: '申請者',
  system_admin: 'システム担当',
  producer: 'プロデューサー',
  ceo: '代表',
};

export const ACTION_LABELS: Record<RingiAction | 'create', string> = {
  create: '申請',
  approve: '承認',
  return: '差し戻し',
  reject: '却下',
  resubmit: '再申請',
};

/** 差し戻し・却下は理由コメントの入力が必須（基本設計書 5.1節）。 */
export const COMMENT_REQUIRED: Record<RingiAction, boolean> = {
  approve: false,
  return: true,
  reject: true,
  resubmit: false,
};

interface TransitionRule {
  action: RingiAction;
  /** 遷移に必要な権限ロール。省略時はロールを問わない。 */
  role?: Role;
  /** true の場合、申請者本人であることを要求する。 */
  owner?: boolean;
}

const TRANSITIONS: Partial<Record<RingiStatus, TransitionRule[]>> = {
  pending_system: [
    { action: 'approve', role: 'system_admin' },
    { action: 'return', role: 'system_admin' },
    { action: 'reject', role: 'system_admin' },
  ],
  pending_producer: [
    { action: 'approve', role: 'producer' },
    { action: 'return', role: 'producer' },
    { action: 'reject', role: 'producer' },
  ],
  pending_ceo: [
    { action: 'approve', role: 'ceo' },
    { action: 'return', role: 'ceo' },
    { action: 'reject', role: 'ceo' },
  ],
  returned: [{ action: 'resubmit', owner: true }],
  // approved / rejected は終端のため定義しない
};

/** 指定ユーザーがこの稟議に対して実行できる操作を返す。 */
export function availableActions(request: RingiRequest, user: AppUser): RingiAction[] {
  const rules = TRANSITIONS[request.status] ?? [];
  return rules
    .filter((rule) => {
      if (rule.owner && request.applicantId !== user.uid) return false;
      if (rule.role && rule.role !== user.role) return false;
      return true;
    })
    .map((rule) => rule.action);
}

/** 終端ステータス（これ以上の操作ができない）かどうか。 */
export function isTerminal(status: RingiStatus): boolean {
  return status === 'approved' || status === 'rejected';
}

/** 承認権限を持つロールかどうか（applicant 以外の3ロール）。 */
export function hasApprovalRole(role: Role): boolean {
  return role === 'system_admin' || role === 'producer' || role === 'ceo';
}
