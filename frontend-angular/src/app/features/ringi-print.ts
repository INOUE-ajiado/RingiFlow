import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../core/auth.service';
import { ACTION_LABELS, AuditLog, RingiRequest, approvalRoute } from '../core/models';
import { RingiService, apiErrorMessage } from '../core/ringi.service';
import { Icon } from '../shared/icon';

/** 押印欄1枠。 */
interface StampBox {
  label: string;
  /** 押印済みの承認者名。未承認なら空。 */
  actor: string;
  /** 押印日（M/d）。未承認なら空。 */
  date: string;
}

/**
 * 決裁書の印刷用ビュー（A4）。
 *
 * 画面の詳細表示とは別に、証跡として保管・回覧できる体裁を用意する。
 * ブラウザの印刷機能でそのままPDF化できるよう、外部ライブラリは使わず
 * @page と印刷用スタイルだけで組む。
 */
@Component({
  selector: 'app-ringi-print',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, CurrencyPipe, Icon],
  template: `
    @if (loading()) {
      <div class="loading">
        <app-icon name="spinner" [size]="24" />
        読み込んでいます...
      </div>
    } @else if (loadError()) {
      <div class="loading">
        <p class="error-message">{{ loadError() }}</p>
      </div>
    } @else if (request(); as req) {
      <!-- 画面上だけに出る操作バー。印刷時は消える -->
      <div class="toolbar no-print">
        <a [routerLink]="['/ringi', req.id]" class="btn btn-secondary">
          <app-icon name="arrow-left" [size]="16" />
          詳細へ戻る
        </a>
        <button type="button" class="btn btn-primary" (click)="print()">
          <app-icon name="print" [size]="16" />
          印刷 / PDF保存
        </button>
      </div>

      <div class="sheet">
        <header class="head">
          <div class="head-title">
            <h1>稟 議 書</h1>
            <p class="head-en">APPROVAL REQUEST FORM</p>
          </div>
          <div class="head-meta">
            <p>稟議番号：{{ req.requestNo }}</p>
            <p>起案日：{{ req.createdAt | date: 'yyyy年M月d日' }}</p>
          </div>
        </header>

        <div class="applicant-row">
          <dl class="applicant">
            <div>
              <dt>所属部門</dt>
              <dd>{{ req.department || '—' }}</dd>
            </div>
            <div>
              <dt>起案者名</dt>
              <dd>{{ req.applicantName }}</dd>
            </div>
            <div>
              <dt>決裁期限</dt>
              <dd>{{ req.dueDate ? (req.dueDate | date: 'yyyy.MM.dd') : '—' }}</dd>
            </div>
          </dl>

          <!-- 押印欄。右から起案者、以降は承認の順に並べる -->
          <div class="stamp-group">
            @for (box of stampBoxes(); track $index) {
              <div class="stamp-block">
                <div class="stamp-label">{{ box.label }}</div>
                <div class="stamp-area">
                  @if (box.actor) {
                    <div class="stamp-mark">
                      <span class="stamp-name">{{ box.actor }}</span>
                      <span class="stamp-date">{{ box.date }}</span>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        </div>

        <section class="block">
          <h2>件名</h2>
          <p class="subject">{{ req.title }}</p>
        </section>

        <section class="block">
          <h2>概要</h2>
          <table class="summary">
            <tbody>
              <tr>
                <td class="label">金額</td>
                <td class="amount">{{ req.amount | currency: 'JPY' : 'symbol' : '1.0-0' }}</td>
              </tr>
              @for (item of summaryItems(); track $index) {
                <tr>
                  <td class="label">{{ item.label }}</td>
                  <td>{{ item.value }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <section class="block">
          <h2>申請理由・目的</h2>
          <p class="purpose">{{ req.content }}</p>
        </section>

        <section class="block">
          <h2>添付資料・備考</h2>
          @if (attachments().length === 0) {
            <p class="none">添付資料なし</p>
          } @else {
            <ul class="files">
              @for (file of attachments(); track file.id) {
                <li><span class="box">□</span> {{ file.fileName }}</li>
              }
            </ul>
          }
        </section>

        <section class="block">
          <h2>決裁経過</h2>
          <table class="history">
            <thead>
              <tr>
                <th class="col-date">日時</th>
                <th class="col-action">操作</th>
                <th class="col-actor">担当者</th>
                <th>コメント</th>
              </tr>
            </thead>
            <tbody>
              @for (log of historyAsc(); track $index) {
                <tr>
                  <td class="col-date">{{ log.timestamp | date: 'yyyy/MM/dd HH:mm' }}</td>
                  <td class="col-action">{{ actionLabel(log.action) }}</td>
                  <td class="col-actor">{{ log.actorName }}</td>
                  <td>{{ log.comment || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <p class="closing">以 上</p>
      </div>
    }
  `,
  styles: `
    /* 用紙設定。余白は @page 側に持たせ、本文は用紙内いっぱいに置く */
    @page {
      size: A4;
      margin: 16mm 15mm;
    }

    :host {
      display: block;
      background: var(--bg-page);
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-7);
      color: var(--text-muted);

      app-icon {
        color: var(--accent);
      }
    }

    .toolbar {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      max-width: 210mm;
      margin: 0 auto var(--space-4);
    }

    /* 用紙。画面では影付きの紙として見せる */
    .sheet {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      padding: 16mm 15mm;
      background: #ffffff;
      color: #000000;
      box-shadow: var(--shadow-md);
      box-sizing: border-box;
      font-size: 10.5pt;
      line-height: 1.8;
    }

    /* ---- 表題 ---- */
    .head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10mm;
      margin-bottom: 10mm;
    }

    .head h1 {
      margin: 0;
      font-size: 24pt;
      letter-spacing: 0.3em;
      color: #000000;
      font-weight: 500;
    }

    .head-en {
      margin: 2mm 0 0;
      font-size: 7pt;
      letter-spacing: 0.2em;
      color: #666666;
    }

    .head-meta {
      text-align: right;
      font-size: 9pt;

      p {
        margin: 0 0 1mm;
      }
    }

    /* ---- 起案者と押印欄 ---- */
    .applicant-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10mm;
      margin-bottom: 10mm;
    }

    .applicant {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4mm;
      padding-top: 2mm;
    }

    .applicant div {
      display: flex;
      align-items: baseline;
      margin: 0;
    }

    .applicant dt {
      width: 24mm;
      font-size: 9pt;
      color: #666666;
    }

    .applicant dd {
      margin: 0;
      font-size: 10pt;
      color: #000000;
    }

    /* 押印欄。罫線で区切った枠を並べる */
    .stamp-group {
      display: flex;
      border: 1px solid #000000;
    }

    .stamp-block {
      width: 18mm;
      height: 22mm;
      border-right: 1px solid #000000;
      display: flex;
      flex-direction: column;
      align-items: center;

      &:last-child {
        border-right: none;
      }
    }

    .stamp-label {
      width: 100%;
      text-align: center;
      font-size: 8pt;
      padding-top: 1mm;
      height: 6mm;
    }

    .stamp-area {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }

    /* 押印。朱色の丸枠に氏名と日付 */
    .stamp-mark {
      width: 13mm;
      height: 13mm;
      border: 1.5px solid #c0392b;
      border-radius: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #c0392b;
      transform: rotate(-8deg);
      line-height: 1.2;
    }

    .stamp-name {
      font-size: 6.5pt;
      font-weight: 700;
      max-width: 12mm;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stamp-date {
      font-size: 5.5pt;
    }

    /* ---- 各項目 ---- */
    .block {
      margin-bottom: 9mm;
      page-break-inside: avoid;
    }

    .block h2 {
      display: flex;
      align-items: center;
      gap: 2mm;
      margin: 0 0 3mm;
      font-size: 10pt;
      font-weight: 500;
      color: #000000;

      &::before {
        content: '';
        display: block;
        width: 1mm;
        height: 3.5mm;
        background: #000000;
      }
    }

    .subject {
      margin: 0;
      padding-left: 3mm;
      font-size: 13pt;
      line-height: 1.5;
    }

    .summary {
      width: 100%;
      border-collapse: collapse;
      border-top: 1px solid #000000;
    }

    .summary td {
      padding: 2.5mm 3mm;
      border-bottom: 1px solid #dddddd;
      vertical-align: top;
      font-size: 10pt;
    }

    .summary .label {
      width: 30mm;
      background: #fafafa;
      font-size: 9pt;
    }

    .summary .amount {
      font-weight: 700;
    }

    .purpose {
      margin: 0;
      padding-left: 3mm;
      white-space: pre-wrap;
      line-height: 2;
    }

    .files {
      margin: 0;
      padding-left: 3mm;
      list-style: none;

      li {
        font-size: 9.5pt;
        margin-bottom: 1.5mm;
      }
    }

    .box {
      margin-right: 2mm;
    }

    .none {
      margin: 0;
      padding-left: 3mm;
      font-size: 9.5pt;
      color: #666666;
    }

    /* 決裁経過 */
    .history {
      width: 100%;
      border-collapse: collapse;
      font-size: 8.5pt;
    }

    .history th {
      text-align: left;
      padding: 2mm;
      background: #fafafa;
      border-bottom: 1px solid #000000;
      font-weight: 500;
    }

    .history td {
      padding: 2mm;
      border-bottom: 1px solid #eeeeee;
      vertical-align: top;
    }

    .col-date {
      width: 30mm;
      white-space: nowrap;
    }

    .col-action {
      width: 20mm;
      white-space: nowrap;
    }

    .col-actor {
      width: 26mm;
      white-space: nowrap;
    }

    .closing {
      margin: 12mm 0 0;
      text-align: center;
      font-size: 9pt;
      letter-spacing: 0.5em;
      color: #666666;
    }

    /* ---- 印刷時 ---- */
    @media print {
      :host {
        background: none;
      }

      .no-print {
        display: none !important;
      }

      .sheet {
        width: auto;
        min-height: 0;
        margin: 0;
        padding: 0;
        box-shadow: none;
      }
    }

    @media (max-width: 220mm) {
      .sheet {
        width: 100%;
        min-height: 0;
        padding: var(--space-5);
      }

      .toolbar {
        max-width: 100%;
      }
    }
  `,
})
export class RingiPrintComponent {
  private readonly ringi = inject(RingiService);
  private readonly auth = inject(AuthService);

  readonly id = input.required<string>();

  readonly request = signal<RingiRequest | null>(null);
  readonly history = signal<AuditLog[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  readonly attachments = computed(() => this.request()?.attachments ?? []);
  readonly summaryItems = computed(() => this.request()?.summary ?? []);

  /** 決裁経過は古い順に読ませる。APIは新しい順に返すため反転する。 */
  readonly historyAsc = computed(() => [...this.history()].reverse());

  /**
   * 押印欄。用紙上は右から左へ「起案者 → 各承認段階」の順に並べる。
   *
   * 承認者名は監査ログから引く。ルート上の段階と履歴の承認操作は順番に
   * 対応するため、n段目の承認は n 番目の approve に当たる。
   */
  readonly stampBoxes = computed<StampBox[]>(() => {
    const req = this.request();
    const threshold = this.auth.config()?.ceoApprovalThreshold;
    if (!req || threshold === undefined) return [];

    const approvals = this.historyAsc().filter((log) => log.action === 'approve');
    const boxes: StampBox[] = approvalRoute(req.amount, threshold).map((step, index) => {
      const approval = approvals[index];
      return {
        label: step.label,
        actor: approval?.actorName ?? '',
        date: approval ? formatStampDate(approval.timestamp) : '',
      };
    });

    boxes.push({
      label: '起案者',
      actor: req.applicantName,
      date: formatStampDate(req.createdAt),
    });

    // 用紙では決裁者が左、起案者が右に来る並びが一般的
    return boxes.reverse();
  });

  constructor() {
    queueMicrotask(() => void this.load());
  }

  actionLabel(action: AuditLog['action']): string {
    return ACTION_LABELS[action];
  }

  print(): void {
    window.print();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const detail = await this.ringi.get(this.id());
      this.request.set(detail.request);
      this.history.set(detail.history);
    } catch (err) {
      this.loadError.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }
}

/** 押印の日付は「月/日」だけを入れる。 */
function formatStampDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}
