part of 'settings_screen.dart';

/// 見出し付きのカードでまとめた設定項目グループ。
class _SettingsSection extends StatelessWidget {
  const _SettingsSection({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            title,
            style: jpStyle(size: 12, weight: FontWeight.w700, color: c.ink3),
          ),
        ),
        ArukuCard(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(children: children),
        ),
      ],
    );
  }
}

/// 設定項目の下に添える補足説明の一文。
class _SettingsNote extends StatelessWidget {
  const _SettingsNote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 2, 0, 8),
      child: Text(
        text,
        style: jpStyle(size: 12, weight: FontWeight.w500, color: c.ink3),
      ),
    );
  }
}

/// オン/オフを切り替える行。
class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.label,
    required this.value,
    required this.onChanged,
    this.switchKey,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  final Key? switchKey;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    // ラベルとスイッチを 1 ノードに統合し、VoiceOver が
    // 「<ラベ>, スイッチ, オン/オフ」と関連づけて読み上げるようにする。
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: jpStyle(size: 15, weight: FontWeight.w600, color: c.ink),
              ),
            ),
            Switch(
              key: switchKey,
              value: value,
              onChanged: onChanged,
              activeTrackColor: c.moss500,
            ),
          ],
        ),
      ),
    );
  }
}

/// 週間目標をプリセットから選ぶ行。選択中のチップを強調し、
/// タップで即座に [onSelected] を呼ぶ（永続化は呼び出し側で行う）。
class _GoalPresetRow extends StatelessWidget {
  const _GoalPresetRow({
    required this.label,
    required this.selectedKm,
    required this.onSelected,
  });

  final String label;
  final double selectedKm;
  final ValueChanged<double> onSelected;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: jpStyle(size: 15, weight: FontWeight.w600, color: c.ink),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final km in AppConstants.weeklyGoalPresetsKm)
                _GoalChip(
                  key: Key('goal_preset_${km.toStringAsFixed(0)}'),
                  text: l10n.settingsWeeklyGoalValue(formatDistanceKm(km)),
                  selected: km == selectedKm,
                  onTap: () => onSelected(km),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// [_GoalPresetRow] 内の 1 つの選択肢チップ。
class _GoalChip extends StatelessWidget {
  const _GoalChip({
    super.key,
    required this.text,
    required this.selected,
    required this.onTap,
  });

  final String text;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    // 選択状態を VoiceOver に伝えるため selected を明示する。
    return MergeSemantics(
      child: Semantics(
        button: true,
        selected: selected,
        child: Material(
          color: selected ? c.moss500 : c.moss100,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
              child: Text(
                text,
                style: numStyle(
                  size: 14,
                  weight: FontWeight.w700,
                  color: selected ? Colors.white : c.moss700,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// タップで外部（端末設定・利用規約などのWebページ）へ誘導する行。
/// [onTap] が null なら無効表示にする。[trailing] が null なら補足文を省く。
class _LinkRow extends StatelessWidget {
  const _LinkRow({
    super.key,
    required this.label,
    this.trailing,
    required this.onTap,
  });

  final String label;
  final String? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final enabled = onTap != null;
    // ラベルと補足（trailing）をまとめ、ボタンとして 1 ノードで読み上げる。
    return MergeSemantics(
      child: Semantics(
        button: true,
        enabled: enabled,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    label,
                    style: jpStyle(
                      size: 15,
                      weight: FontWeight.w600,
                      color: enabled ? c.ink : c.ink3,
                    ),
                  ),
                ),
                if (trailing != null) ...[
                  Text(
                    trailing!,
                    style: jpStyle(
                      size: 13,
                      weight: FontWeight.w600,
                      color: c.ink3,
                    ),
                  ),
                  const SizedBox(width: 4),
                ],
                Ic.chevron(size: 16, color: c.ink3, dir: ChevronDir.right),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
