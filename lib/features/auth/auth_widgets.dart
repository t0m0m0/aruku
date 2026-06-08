part of 'auth_screen.dart';

/// 認証フォームのテキスト入力。
class _AuthField extends StatelessWidget {
  const _AuthField({
    required this.controller,
    required this.hint,
    this.obscure = false,
    this.keyboardType,
  });

  final TextEditingController controller;
  final String hint;
  final bool obscure;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: c.paper,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.hairline),
      ),
      alignment: Alignment.center,
      child: TextField(
        controller: controller,
        obscureText: obscure,
        keyboardType: keyboardType,
        autocorrect: false,
        enableSuggestions: !obscure,
        cursorColor: c.moss500,
        style: jpStyle(size: 15, weight: FontWeight.w600, color: c.ink),
        decoration: InputDecoration(
          isCollapsed: true,
          border: InputBorder.none,
          hintText: hint,
          hintStyle: jpStyle(size: 15, weight: FontWeight.w500, color: c.ink3),
        ),
      ),
    );
  }
}

/// テキストだけのタップ可能なリンク。[onTap] が null なら無効。
class _TextLink extends StatelessWidget {
  const _TextLink({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Center(
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Text(
            label,
            style: jpStyle(
              size: 13,
              weight: FontWeight.w700,
              color: onTap == null ? c.ink3 : c.moss600,
            ),
          ),
        ),
      ),
    );
  }
}
