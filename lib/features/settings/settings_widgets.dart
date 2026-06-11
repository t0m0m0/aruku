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
