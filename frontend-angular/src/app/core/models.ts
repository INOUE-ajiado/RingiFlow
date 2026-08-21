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
  | 'returned'
  | 'withdrawn';

/**
 * 権限ロール。
 *
 * 'master' は全工程を単独で操作できるテスト運用専用のロール。統合先システムから
 * 認証・権限を受け取るまでの暫定措置であり、統合時には付与をやめる。
 */
export type Role = 'applicant' | 'system_admin' | 'producer' | 'ceo' | 'master';

export type RingiAction = 'approve' | 'return' | 'reject' | 'resubmit' | 'withdraw';

/** 監査ログに記録される操作（状態遷移以外も含む）。 */
export type LogAction = RingiAction | 'create' | 'attach' | 'detach';

/** 添付ファイルのメタデータ。実体は Cloud Storage にあり、APIを経由して取得する。 */
export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: string;
}

export interface AppUser {
  uid: string;
  employeeId: string;
  name: string;
  role: Role;
}

export interface RingiRequest {
  id: string;
  /** 人が読める稟議番号（例: R-2026-0001）。 */
  requestNo: string;
  title: string;
  content: string;
  amount: number;
  applicantId: string;
  applicantName: string;
  applicantEmployeeId: string;
  status: RingiStatus;
  attachments: Attachment[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  requestId: string;
  action: LogAction;
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
  withdrawn: '取り下げ',
};

export const ROLE_LABELS: Record<Role, string> = {
  applicant: '申請者',
  system_admin: 'システム担当',
  producer: 'プロデューサー',
  ceo: '代表',
  master: 'マスター（全権限）',
};

export const ACTION_LABELS: Record<LogAction, string> = {
  create: '申請',
  approve: '承認',
  return: '差し戻し',
  reject: '却下',
  resubmit: '再申請',
  withdraw: '取り下げ',
  attach: 'ファイル添付',
  detach: 'ファイル削除',
};

/** 差し戻し・却下は理由コメントの入力が必須（基本設計書 5.1節）。 */
export const COMMENT_REQUIRED: Record<RingiAction, boolean> = {
  approve: false,
  return: true,
  reject: true,
  resubmit: false,
  withdraw: false,
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
    { action: 'withdraw', owner: true },
  ],
  pending_producer: [
    { action: 'approve', role: 'producer' },
    { action: 'return', role: 'producer' },
    { action: 'reject', role: 'producer' },
    { action: 'withdraw', owner: true },
  ],
  pending_ceo: [
    { action: 'approve', role: 'ceo' },
    { action: 'return', role: 'ceo' },
    { action: 'reject', role: 'ceo' },
    { action: 'withdraw', owner: true },
  ],
  returned: [
    { action: 'resubmit', owner: true },
    { action: 'withdraw', owner: true },
  ],
  // approved / rejected / withdrawn は終端のため定義しない
};

/** 指定ユーザーがこの稟議に対して実行できる操作を返す。 */
export function availableActions(request: RingiRequest, user: AppUser): RingiAction[] {
  const rules = TRANSITIONS[request.status] ?? [];
  // マスターロールは担当者判定を迂回し、そのステータスで定義された操作をすべて行える。
  // 状態遷移表そのものは迂回しないため、終端ステータスでは何も表示されない。
  if (isMaster(user.role)) {
    return rules.map((rule) => rule.action);
  }
  return rules
    .filter((rule) => {
      if (rule.owner && request.applicantId !== user.uid) return false;
      if (rule.role && rule.role !== user.role) return false;
      return true;
    })
    .map((rule) => rule.action);
}

/** 全工程を操作できるテスト運用専用ロールかどうか。 */
export function isMaster(role: Role): boolean {
  return role === 'master';
}

/** 終端ステータス（これ以上の操作ができない）かどうか。 */
export function isTerminal(status: RingiStatus): boolean {
  return status === 'approved' || status === 'rejected' || status === 'withdrawn';
}

/** 承認待ち（決裁の進行中）のステータスかどうか。 */
export function isPending(status: RingiStatus): boolean {
  return status === 'pending_system' || status === 'pending_producer' || status === 'pending_ceo';
}

/** 承認権限を持つロールかどうか（applicant 以外）。 */
export function hasApprovalRole(role: Role): boolean {
  return role === 'system_admin' || role === 'producer' || role === 'ceo' || role === 'master';
}

/** 添付ファイルを変更できるか（申請者本人かつ決裁確定前）。 */
export function canModifyAttachments(request: RingiRequest, user: AppUser): boolean {
  if (isTerminal(request.status)) return false;
  if (isMaster(user.role)) return true;
  return request.applicantId === user.uid;
}

/** バイト数を人が読める表記へ変換する。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
