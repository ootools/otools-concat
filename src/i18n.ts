/**
 * i18n（宿主标准 8 语种，扁平 JSON + {placeholder} 插值 + en-US 兜底）。
 * locale 跟随宿主：html[lang] → localStorage('otools:locale') → navigator.language；
 * 监听宿主 otools-locale-changed 事件与 html[lang] MutationObserver。
 * ar-SA 驱动 dir=rtl（布局用 CSS 逻辑属性自动镜像；时间线保持 LTR）。
 */
import { computed, ref } from 'vue';
import type { ComputedRef } from 'vue';
import en from '../i18n/en-US.json';

const supportedLocales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'de-DE', 'ru-RU', 'es-ES', 'ar-SA'] as const;
export type Locale = (typeof supportedLocales)[number];
/** 以 en-US 为真源的类型化 key（缺 key 直接编译报错）。 */
export type MessageKey = keyof typeof en;
type MessageDictionary = Record<MessageKey, string>;

const messages = import.meta.glob<MessageDictionary>('../i18n/*.json', {
  eager: true,
  import: 'default',
});

function normalizeLocale(value: string): Locale {
  const language = value.trim().replace(/_/g, '-').toLowerCase();
  const exact = supportedLocales.find((locale) => locale.toLowerCase() === language);
  if (exact) return exact;
  const base = language.split('-')[0];
  return supportedLocales.find((locale) => locale.toLowerCase().startsWith(`${base}-`)) ?? 'zh-CN';
}

function initialLocale(): Locale {
  const documentLocale = typeof document === 'undefined' ? '' : document.documentElement.lang;
  if (documentLocale) return normalizeLocale(documentLocale);
  try {
    const storedLocale = typeof window === 'undefined' ? null : window.localStorage.getItem('otools:locale');
    if (storedLocale) return normalizeLocale(storedLocale);
  } catch {
    // 嵌入式 webview 里 storage 可能不可用
  }
  return normalizeLocale(typeof navigator === 'undefined' ? '' : navigator.language);
}

function messageFor(locale: Locale, key: MessageKey): string | undefined {
  const message = messages[`../i18n/${locale}.json`]?.[key];
  return typeof message === 'string' ? message : undefined;
}

const locale = ref<Locale>(initialLocale());
const direction = computed<'ltr' | 'rtl'>(() => (locale.value === 'ar-SA' ? 'rtl' : 'ltr'));

export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const message =
    messageFor(locale.value, key) ?? messageFor('en-US', key) ?? messageFor('zh-CN', key) ?? key;
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values?.[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder;
  });
}

export function getLocale(): Locale {
  return locale.value;
}

export function getDirection(): 'ltr' | 'rtl' {
  return direction.value;
}

let installed = false;

/** 应用启动时安装一次：同步 html lang/dir 并监听宿主 locale 变化。 */
export function installI18n(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const applyDocument = () => {
    document.documentElement.lang = locale.value;
    document.documentElement.dir = direction.value;
  };
  applyDocument();
  const onLocaleChanged = (event: Event) => {
    const value = (event as CustomEvent<{ locale?: unknown }>).detail?.locale;
    if (typeof value === 'string' && value.trim()) {
      locale.value = normalizeLocale(value);
      applyDocument();
    }
  };
  window.addEventListener('otools-locale-changed', onLocaleChanged);
  const observer =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          const next = initialLocale();
          if (next !== locale.value) {
            locale.value = next;
            applyDocument();
          }
        })
      : undefined;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}

/** 组件层取当前的只读 locale（响应式）。 */
export function useLocale(): { locale: ComputedRef<Locale>; direction: ComputedRef<'ltr' | 'rtl'> } {
  return { locale: computed(() => locale.value), direction };
}
