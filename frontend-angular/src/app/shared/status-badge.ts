import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { RingiStatus, STATUS_LABELS } from '../core/models';

/** ステータスを色付きバッジで表示する。 */
@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge" [class]="cssClass()">{{ label() }}</span>`,
})
export class StatusBadge {
  readonly status = input.required<RingiStatus>();

  readonly label = computed(() => STATUS_LABELS[this.status()]);

  readonly cssClass = computed(() => {
    switch (this.status()) {
      case 'approved':
        return 'badge-approved';
      case 'rejected':
        return 'badge-rejected';
      case 'returned':
        return 'badge-returned';
      default:
        return 'badge-pending';
    }
  });
}
