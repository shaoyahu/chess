'use client';

/**
 * 自绘下拉选择器（Picker）—— **不用原生 `<select>`**。
 *
 * 为什么不用原生控件：
 *   原生 `<select>` 在 macOS / Windows / 移动端各画各的，样式完全不受控；
 *   即便用 `appearance: none` 接管了外观，展开后的**选项列表**仍是系统绘制的，
 *   圆角、行高、选中态都没法统一 —— 看起来就是「半个原生控件」。
 *
 * 这里整套自绘：触发按钮 + 浮层列表，键盘可达（↑↓ / Home / End / Enter / Esc），
 * 焦点始终留在触发器上（选项按钮 `tabIndex={-1}`），读屏走 combobox 语义。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  /** 补充说明（可选，显示在标题下面） */
  hint?: string;
}

export interface PickerProps<T extends string> {
  value: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  /** 触发器的 id（给外部 label 关联用） */
  id?: string;
  disabled?: boolean;
  /** 无障碍名（触发器上没有可见文字时用） */
  ariaLabel?: string;
}

export function Picker<T extends string>({
  value,
  options,
  onChange,
  id,
  disabled,
  ariaLabel,
}: PickerProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  /** 打开并把「当前高亮」落到选中项上 */
  const openWith = useCallback(
    (index: number) => {
      setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
      setOpen(true);
    },
    [options.length],
  );

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      setOpen(false);
      if (option && option.value !== value) onChange(option.value);
      // 选完把焦点还给触发器：选项按钮随浮层一起卸载，焦点不能丢
      triggerRef.current?.focus();
    },
    [onChange, options, value],
  );

  const moveActive = useCallback(
    (delta: number) => {
      setActiveIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
    },
    [options.length],
  );

  // 点外面 → 收起
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (open) moveActive(1);
        else openWith(selectedIndex >= 0 ? selectedIndex : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (open) moveActive(-1);
        else openWith(selectedIndex >= 0 ? selectedIndex : 0);
        break;
      case 'Enter':
      case ' ':
        // 收起时让浏览器自己派发 click（= 打开）；展开时由键盘直接选中
        if (open) {
          e.preventDefault();
          choose(activeIndex);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case 'Home':
        if (open) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open) {
          e.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      default:
        break;
    }
  };

  return (
    <div className="picker" ref={wrapRef}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className="picker-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-opt-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        data-value={current?.value ?? ''}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openWith(selectedIndex >= 0 ? selectedIndex : 0))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="picker-value">{current?.label ?? '—'}</span>
        <ChevronDown className="picker-chevron" size={15} aria-hidden="true" />
      </button>

      {open && (
        <div className="picker-menu" id={menuId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={option.value}
              id={`${menuId}-opt-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              data-value={option.value}
              className={`picker-option${option.value === value ? ' selected' : ''}`}
              data-active={index === activeIndex ? 'true' : 'false'}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="picker-option-text">
                <span className="picker-option-label">{option.label}</span>
                {option.hint && <span className="picker-option-hint">{option.hint}</span>}
              </span>
              {option.value === value && (
                <Check className="picker-tick" size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default Picker;
