import 'package:flutter/material.dart';

import '../../core/theme/aruku_theme.dart';

/// Shared surface container used across screens.
///
/// Consolidates the repeated
/// `Container(decoration: BoxDecoration(rounded/hairline/shadow))` card
/// pattern into a single, theme-aware widget.
class ArukuCard extends StatelessWidget {
  const ArukuCard({
    super.key,
    required this.child,
    this.color,
    this.borderRadius = 18,
    this.bordered = true,
    this.borderColor,
    this.shadow,
    this.padding,
    this.width,
    this.height,
    this.clipBehavior = Clip.none,
  });

  final Widget child;

  /// Overrides the default `paper` background color.
  final Color? color;

  final double borderRadius;

  /// Whether to draw a hairline border. Defaults to `true`.
  final bool bordered;

  /// Overrides the default hairline border color.
  final Color? borderColor;

  /// Optional drop shadow applied behind the card.
  final List<BoxShadow>? shadow;

  final EdgeInsetsGeometry? padding;
  final double? width;
  final double? height;
  final Clip clipBehavior;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      width: width,
      height: height,
      padding: padding,
      clipBehavior: clipBehavior,
      decoration: BoxDecoration(
        color: color ?? c.paper,
        borderRadius: BorderRadius.circular(borderRadius),
        border: bordered ? Border.all(color: borderColor ?? c.hairline) : null,
        boxShadow: shadow,
      ),
      child: child,
    );
  }
}
