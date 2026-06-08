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

/// 項目間の区切り線。
class _RowDivider extends StatelessWidget {
  const _RowDivider();

  @override
  Widget build(BuildContext context) {
    return Divider(height: 1, thickness: 1, color: context.c.hairline);
  }
}

/// 既定の時間予算を選ぶ行。候補をチップで横並びにする。
class _BudgetRow extends StatelessWidget {
  const _BudgetRow({
    required this.value,
    required this.choices,
    required this.onChanged,
  });

  final int value;
  final List<int> choices;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '時間予算の既定',
            style: jpStyle(size: 15, weight: FontWeight.w600, color: c.ink),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            children: [
              for (final m in choices)
                _ChoiceChip(
                  label: '$m分',
                  selected: m == value,
                  onTap: () => onChanged(m),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 距離の表示単位を選ぶ行。
class _UnitRow extends StatelessWidget {
  const _UnitRow({required this.value, required this.onChanged});

  final DistanceUnit value;
  final ValueChanged<DistanceUnit> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '距離の単位',
              style: jpStyle(size: 15, weight: FontWeight.w600, color: c.ink),
            ),
          ),
          _ChoiceChip(
            label: 'km',
            selected: value == DistanceUnit.kilometers,
            onTap: () => onChanged(DistanceUnit.kilometers),
          ),
          const SizedBox(width: 8),
          _ChoiceChip(
            label: 'mi',
            selected: value == DistanceUnit.miles,
            onTap: () => onChanged(DistanceUnit.miles),
          ),
        ],
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
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
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
            value: value,
            onChanged: onChanged,
            activeTrackColor: c.moss500,
          ),
        ],
      ),
    );
  }
}

/// タップで外部（端末設定・将来のアカウント画面）へ誘導する行。
/// [onTap] が null なら無効表示にする。
class _LinkRow extends StatelessWidget {
  const _LinkRow({
    required this.label,
    required this.trailing,
    required this.onTap,
  });

  final String label;
  final String trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final enabled = onTap != null;
    return InkWell(
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
            Text(
              trailing,
              style: jpStyle(size: 13, weight: FontWeight.w600, color: c.ink3),
            ),
            const SizedBox(width: 4),
            Ic.chevron(size: 16, color: c.ink3, dir: ChevronDir.right),
          ],
        ),
      ),
    );
  }
}

/// 選択状態を持つ小さなチップ。
class _ChoiceChip extends StatelessWidget {
  const _ChoiceChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? c.moss500 : c.paper,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: selected ? c.moss500 : c.hairline),
        ),
        child: Text(
          label,
          style: jpStyle(
            size: 14,
            weight: FontWeight.w700,
            color: selected ? Colors.white : c.ink2,
          ),
        ),
      ),
    );
  }
}
