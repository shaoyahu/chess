'use client';

/**
 * 设置弹窗 —— 顶栏齿轮点开的浮层。
 *
 * 放哪些设置（用户拍板）：
 *   - **音效**：开关 + 音量。默认**关**（用户要求：默认关，开关放设置里）。
 *   - **棋盘外观**：几套纯色配色（蓝白 / 绿白 / 灰白 / 原木 / 木纹）。
 *   - **辅助下棋**：打开后 HUD 里出现「提示」按钮，**点它**才显示「推荐下一步」的蓝色指引箭头。
 *   - **翻转棋盘**：手动把棋盘转 180°（默认还是按自己的执子颜色朝向）。
 *
 * 另外一组**界面偏好**（字号 / 密度 / 圆角）：连续维度，用滑块而不是分段按钮。
 *
 * 弹层是 `position: fixed` 的，不占文档流 —— 打开设置不会把页面顶出滚动条。
 */
import { Palette, Sparkles, FlipHorizontal, Volume2, Shapes } from 'lucide-react';
import { BOARD_THEMES } from '@/lib/board-themes';
import { PIECE_STYLES, PIECE_MATERIALS, PREVIEW_PIECE } from '@/lib/piece-appearance';
import { PieceGlyph } from '@/components/PieceGlyph';
import type { GameSettings } from '@/lib/settings';
import { playSound, resumeAudio } from '@/lib/sound';
import { UI_PREF_RANGE, type UiPrefs } from '@/lib/ui-prefs';

export interface SettingsDialogProps {
  open: boolean;
  settings: GameSettings;
  /** 界面偏好（字号 / 密度 / 圆角） */
  uiPrefs: UiPrefs;
  onChange: (next: GameSettings) => void;
  onUiPrefsChange: (next: UiPrefs) => void;
  onClose: () => void;
}

export function SettingsDialog({
  open,
  settings,
  uiPrefs,
  onChange,
  onUiPrefsChange,
  onClose,
}: SettingsDialogProps): React.ReactElement | null {
  if (!open) return null;

  const patch = (part: Partial<GameSettings>): void => onChange({ ...settings, ...part });

  /** 三个界面偏好滑块 */
  const prefRow = (
    label: string,
    hint: string,
    key: keyof typeof UI_PREF_RANGE,
    ariaLabel: string,
    display: (v: number) => string,
    min: number,
    max: number,
    step: number,
  ): React.ReactElement => {
    const value = uiPrefs[key];
    return (
      <section className="settings-row">
        <div className="settings-label">
          <span className="settings-name">{label}</span>
          <span className="settings-hint">{hint}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            className="settings-range"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onUiPrefsChange({ ...uiPrefs, [key]: Number(e.target.value) })}
            aria-label={ariaLabel}
          />
          <span className="settings-value">{display(value)}</span>
        </div>
      </section>
    );
  };

  return (
    <div className="overlay settings-overlay" onClick={onClose}>
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <div className="settings-head">
          <div className="section-title">
            <span className="eyebrow">Settings</span>
            <span className="zh">设置</span>
          </div>
          <button className="btn small ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="settings-body">
          {/* ---------- 音效 ---------- */}
          <section className="settings-row">
            <div className="settings-label">
              <span className="settings-name">
                <Volume2 size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 5 }} />
                音效
              </span>
              <span className="settings-hint">落子、吃子、将军的提示音</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.soundEnabled}
                onChange={(e) => {
                  const on = e.target.checked;
                  if (on) {
                    // 浏览器要求音频上下文在用户手势里解锁
                    resumeAudio();
                    playSound('click', settings.soundVolume);
                  }
                  patch({ soundEnabled: on });
                }}
                aria-label="音效开关"
              />
              <span className="switch-track" aria-hidden="true" />
            </label>
          </section>

          <section className="settings-row">
            <div className="settings-label">
              <span className="settings-name">音量</span>
              <span className="settings-hint">{Math.round(settings.soundVolume * 100)}%</span>
            </div>
            <input
              className="settings-range"
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(settings.soundVolume * 100)}
              disabled={!settings.soundEnabled}
              onChange={(e) => patch({ soundVolume: Number(e.target.value) / 100 })}
              aria-label="音量"
            />
          </section>

          {/* ---------- 棋盘外观 ---------- */}
          <section className="settings-block">
            <div className="settings-name">
              <Palette size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 5 }} />
              棋盘外观
            </div>
            <div className="theme-grid">
              {BOARD_THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-chip${settings.boardTheme === t.id ? ' active' : ''}`}
                  onClick={() => patch({ boardTheme: t.id })}
                  title={t.label}
                  aria-pressed={settings.boardTheme === t.id}
                >
                  <span className="theme-preview">
                    <i style={{ background: t.light }} />
                    <i style={{ background: t.dark }} />
                    <i style={{ background: t.dark }} />
                    <i style={{ background: t.light }} />
                  </span>
                  <span className="theme-name">{t.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ---------- 棋子风格 + 棋子材质 ---------- */}
          {/*
           * 两个切换块是**正交**的：风格管造型，材质管表面。
           *
           * 预览用**同一枚棋子**（王）横排对比 ——
           * 换棋子就没法比较了；预览里另外一维取**当前值**，
           * 所以「改风格时看到的是当前材质下的样子」，改哪一维都即时可见。
           */}
          <section className="settings-block">
            <div className="settings-name">
              <Shapes size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 5 }} />
              棋子风格
            </div>
            <div className="piece-grid">
              {PIECE_STYLES.map((s) => (
                <button
                  key={s.id}
                  className={`piece-chip${settings.pieceStyle === s.id ? ' active' : ''}`}
                  onClick={() => patch({ pieceStyle: s.id })}
                  aria-pressed={settings.pieceStyle === s.id}
                  aria-label={`棋子风格：${s.label}`}
                >
                  <span className="piece-chip-preview">
                    <PieceGlyph
                      type={PREVIEW_PIECE}
                      color="w"
                      size={34}
                      style={s.id}
                      material={settings.pieceMaterial}
                    />
                  </span>
                  <span className="piece-chip-name">{s.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-block">
            <div className="settings-name">棋子材质</div>
            <div className="piece-grid">
              {PIECE_MATERIALS.map((m) => (
                <button
                  key={m.id}
                  className={`piece-chip${settings.pieceMaterial === m.id ? ' active' : ''}`}
                  onClick={() => patch({ pieceMaterial: m.id })}
                  aria-pressed={settings.pieceMaterial === m.id}
                  aria-label={`棋子材质：${m.label}`}
                >
                  <span className="piece-chip-preview">
                    <PieceGlyph
                      type={PREVIEW_PIECE}
                      color="w"
                      size={34}
                      style={settings.pieceStyle}
                      material={m.id}
                    />
                  </span>
                  <span className="piece-chip-name">{m.label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ---------- 辅助下棋 ---------- */}
          <section className="settings-row">
            <div className="settings-label">
              <span className="settings-name">
                <Sparkles size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 5 }} />
                辅助下棋
              </span>
              <span className="settings-hint">HUD 里多一个「提示」按钮，点它才显示推荐下一步（蓝色箭头）</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.hintEnabled}
                onChange={(e) => patch({ hintEnabled: e.target.checked })}
                aria-label="辅助下棋开关"
              />
              <span className="switch-track" aria-hidden="true" />
            </label>
          </section>

          {/* ---------- 翻转棋盘 ---------- */}
          <section className="settings-row">
            <div className="settings-label">
              <span className="settings-name">
                <FlipHorizontal size={13} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 5 }} />
                翻转棋盘
              </span>
              <span className="settings-hint">默认按自己的执子颜色朝向</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.flipBoard}
                onChange={(e) => patch({ flipBoard: e.target.checked })}
                aria-label="翻转棋盘开关"
              />
              <span className="switch-track" aria-hidden="true" />
            </label>
          </section>

          {/* ---------- 界面偏好（连续维度 → 滑块） ---------- */}
          <section className="settings-block">
            <div className="settings-name">界面偏好</div>
            <p className="settings-hint" style={{ marginTop: 3 }}>
              只影响这台设备，刷新后保留。
            </p>
          </section>

          {prefRow(
            '字号',
            '整体文字大小',
            'scale',
            '界面字号',
            (v) => `${Math.round(v * 100)}%`,
            UI_PREF_RANGE.scale.min,
            UI_PREF_RANGE.scale.max,
            UI_PREF_RANGE.scale.step,
          )}
          {prefRow(
            '密度',
            '控件之间的疏密',
            'density',
            '界面密度',
            (v) => `${Math.round(v * 100)}%`,
            UI_PREF_RANGE.density.min,
            UI_PREF_RANGE.density.max,
            UI_PREF_RANGE.density.step,
          )}
          {prefRow(
            '圆角',
            '面板与按钮的圆角',
            'radius',
            '界面圆角',
            (v) => `${Math.round(v)}px`,
            UI_PREF_RANGE.radius.min,
            UI_PREF_RANGE.radius.max,
            UI_PREF_RANGE.radius.step,
          )}
        </div>
      </div>
    </div>
  );
}

export default SettingsDialog;
