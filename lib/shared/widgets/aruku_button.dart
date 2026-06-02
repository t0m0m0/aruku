import 'package:flutter/material.dart';

import '../../core/theme/aruku_theme.dart';

/// Visual style of an [ArukuButton].
enum ArukuButtonVariant {
  /// Solid background (e.g. primary CTA).
  filled,

  /// Transparent fill with a hairline border (e.g. secondary action).
  outlined,
}

/// Shared tappable button used across screens.
///
/// Consolidates the repeated `Material + InkWell + Ink(rounded/border/shadow)`
/// pattern into a single, theme-aware widget.
class ArukuButton extends StatelessWidget {
  const ArukuButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = ArukuButtonVariant.filled,
    this.icon,
    this.backgroundColor,
    this.foregroundColor,
    this.borderColor,
    this.shadow,
    this.textStyle,
    this.height = 52,
    this.borderRadius = 16,
    this.iconGap = 10,
    this.fullWidth = true,
  });

  final String label;
  final VoidCallback onPressed;
  final ArukuButtonVariant variant;

  /// Optional leading widget rendered before the label.
  final Widget? icon;

  /// Overrides the variant's default background color.
  final Color? backgroundColor;

  /// Overrides the variant's default text/icon color.
  final Color? foregroundColor;

  /// Overrides the outlined variant's default border color.
  final Color? borderColor;

  /// Optional drop shadow applied behind the button.
  final List<BoxShadow>? shadow;

  /// Overrides the default label text style.
  final TextStyle? textStyle;

  final double height;
  final double borderRadius;

  /// Horizontal gap between [icon] and the label.
  final double iconGap;

  final bool fullWidth;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final isFilled = variant == ArukuButtonVariant.filled;

    final bg = backgroundColor ?? (isFilled ? c.moss600 : c.paper);
    final fg = foregroundColor ?? (isFilled ? c.ivory : c.ink);
    final radius = BorderRadius.circular(borderRadius);

    final label = Text(
      this.label,
      style:
          textStyle ??
          jpStyle(
            size: 16,
            weight: isFilled ? FontWeight.w800 : FontWeight.w700,
            color: fg,
          ),
    );

    final Widget content = icon == null
        ? label
        : Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              icon!,
              SizedBox(width: iconGap),
              label,
            ],
          );

    return Material(
      color: bg,
      borderRadius: radius,
      child: InkWell(
        onTap: onPressed,
        borderRadius: radius,
        child: Ink(
          width: fullWidth ? double.infinity : null,
          height: height,
          decoration: BoxDecoration(
            borderRadius: radius,
            border: isFilled
                ? null
                : Border.all(color: borderColor ?? c.hairline),
            boxShadow: shadow,
          ),
          child: Center(child: content),
        ),
      ),
    );
  }
}
