import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** 使用できるアイコンの名前。 */
export type IconName =
  | 'arrow-left'
  | 'plus'
  | 'brand'
  | 'spinner'
  | 'search'
  | 'paperclip'
  | 'trash'
  | 'chevron-right'
  | 'check'
  | 'circle'
  | 'dot';

/**
 * 線画アイコン。
 *
 * 形はすべて 24x24 のビューボックスに揃え、線幅・線端・色は CSS（.icon）で
 * 一括して制御する。スプライトと <use> を使わずコンポーネント内に直接描くのは、
 * 参照解決やサニタイズの挙動に依存せず、どの描画経路でも同じ結果になるため。
 *
 * 色は currentColor を継承するので、置いた場所の文字色に自然に馴染む。
 */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="icon"
      [class.icon--dot]="name() === 'dot'"
      [class.icon--spin]="name() === 'spinner'"
      [style.--icon-size.px]="size()"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      @switch (name()) {
        @case ('arrow-left') {
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        }
        @case ('plus') {
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        }
        @case ('brand') {
          <path d="M8 20V4h5.5a4 4 0 0 1 0 8H8" />
          <path d="M12 12l5 8" />
        }
        @case ('spinner') {
          <path d="M12 3a9 9 0 1 0 9 9" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        }
        @case ('paperclip') {
          <path
            d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.48"
          />
        }
        @case ('trash') {
          <polyline points="3 6 5 6 21 6" />
          <path
            d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
          />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        }
        @case ('chevron-right') {
          <polyline points="9 6 15 12 9 18" />
        }
        @case ('check') {
          <polyline points="20 6 9 17 4 12" />
        }
        @default {
          <!-- circle / dot は同じ形。塗りの有無だけ .icon--dot で切り替える -->
          <circle cx="12" cy="12" r="4" />
        }
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();

  /** 表示サイズ（px）。既定は行内の文字に馴染む 18px。 */
  readonly size = input(18);

  protected readonly isDot = computed(() => this.name() === 'dot');
}
