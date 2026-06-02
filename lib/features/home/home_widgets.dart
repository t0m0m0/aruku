part of 'home_screen.dart';

class _DestinationCard extends StatelessWidget {
  const _DestinationCard({
    required this.departure,
    required this.destination,
    required this.onTapDeparture,
    required this.onTapDestination,
  });
  final String departure;
  final String? destination;
  final VoidCallback onTapDeparture;
  final VoidCallback onTapDestination;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuCard(
      borderRadius: 22,
      shadow: const [
        BoxShadow(
          color: Color(0x0F22361E),
          blurRadius: 24,
          offset: Offset(0, 8),
        ),
      ],
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Stack(
        children: [
          // dot column
          Positioned(
            left: 16,
            top: 24,
            bottom: 24,
            child: Column(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: c.moss500,
                    shape: BoxShape.circle,
                    border: Border.all(color: c.moss100, width: 3),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Container(width: 2, color: c.moss200),
                  ),
                ),
                Ic.pin(size: 16, color: c.burnt, filled: true),
              ],
            ),
          ),
          Column(
            children: [
              // From
              InkWell(
                onTap: onTapDeparture,
                borderRadius: BorderRadius.circular(12),
                child: Ink(
                  padding: const EdgeInsets.fromLTRB(38, 12, 0, 12),
                  decoration: BoxDecoration(
                    border: Border(bottom: BorderSide(color: c.hairline)),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '出発',
                              style: jpStyle(
                                size: 11,
                                weight: FontWeight.w600,
                                color: c.ink3,
                                letterSpacing: 0.04 * 11,
                              ),
                            ),
                            Text(
                              departure,
                              style: jpStyle(
                                size: 16,
                                weight: FontWeight.w700,
                                color: c.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Ic.swap(size: 18, color: c.ink3),
                      ),
                    ],
                  ),
                ),
              ),
              // To
              InkWell(
                onTap: onTapDestination,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(38, 12, 0, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '目的地',
                              style: jpStyle(
                                size: 11,
                                weight: FontWeight.w600,
                                color: c.ink3,
                                letterSpacing: 0.04 * 11,
                              ),
                            ),
                            Text(
                              destination ?? 'タップして入力',
                              style: jpStyle(
                                size: 16,
                                weight: destination != null
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                                color: destination != null ? c.ink : c.ink3,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(6),
                        child: Ic.swap(size: 18, color: c.ink3),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _TimeField extends StatelessWidget {
  const _TimeField({
    required this.label,
    required this.time,
    required this.date,
    required this.sub,
    required this.anchored,
    required this.onTap,
  });

  final String label;
  final String time;
  final String? date;
  final String sub;
  final bool anchored;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: anchored ? c.moss50 : Colors.transparent,
            border: Border.all(
              color: anchored ? c.moss200 : Colors.transparent,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    label,
                    style: jpStyle(
                      size: 10,
                      weight: FontWeight.w800,
                      color: c.ink3,
                      letterSpacing: 0.08 * 10,
                    ),
                  ),
                  if (anchored) ...[
                    const SizedBox(width: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      decoration: BoxDecoration(
                        color: c.moss200,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        '固定',
                        style: jpStyle(
                          size: 9,
                          weight: FontWeight.w700,
                          color: c.moss700,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
              if (date != null) ...[
                const SizedBox(height: 2),
                Text(
                  date!,
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w700,
                    color: c.moss700,
                  ),
                ),
              ],
              const SizedBox(height: 1),
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Text(
                    time,
                    style: numStyle(
                      size: 20,
                      weight: FontWeight.w500,
                      color: c.ink,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      sub,
                      overflow: TextOverflow.ellipsis,
                      style: jpStyle(
                        size: 11,
                        weight: FontWeight.w600,
                        color: c.ink3,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SummaryItem extends StatelessWidget {
  const _SummaryItem({
    required this.label,
    required this.value,
    required this.unit,
    required this.leading,
  });
  final String label;
  final String value;
  final String unit;
  final bool leading;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Expanded(
      child: Container(
        padding: EdgeInsets.only(left: leading ? 16 : 0),
        decoration: leading
            ? BoxDecoration(
                border: Border(left: BorderSide(color: c.moss200)),
              )
            : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: jpStyle(
                size: 10,
                weight: FontWeight.w700,
                color: c.moss700,
                letterSpacing: 0.06 * 10,
              ),
            ),
            const SizedBox(height: 2),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Flexible(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      value,
                      style: numStyle(
                        size: 22,
                        weight: FontWeight.w600,
                        color: c.moss800,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 3),
                Text(
                  unit,
                  style: jpStyle(
                    size: 11,
                    weight: FontWeight.w700,
                    color: c.moss700,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchCTA extends StatelessWidget {
  const _SearchCTA({required this.onPressed});
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ArukuButton(
      label: 'ルートを検索',
      onPressed: onPressed,
      icon: Ic.routes(size: 20, color: c.ivory),
      height: 60,
      borderRadius: 20,
      shadow: const [
        BoxShadow(
          color: Color(0x5C35501A),
          blurRadius: 28,
          offset: Offset(0, 10),
        ),
      ],
      textStyle: jpStyle(
        size: 18,
        weight: FontWeight.w800,
        color: c.ivory,
        letterSpacing: 0.06 * 18,
      ),
    );
  }
}
